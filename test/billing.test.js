import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { PDFDocument } from "pdf-lib";
import worker from "../src/index.js";
import { signPayload, verifyWebhook, formEncode } from "../src/lib/stripe.js";

const SUPABASE_URL = "https://proj.supabase.co";
const ALICE = "11111111-1111-1111-1111-111111111111";
const BOB = "22222222-2222-2222-2222-222222222222";
const WHSEC = "whsec_test_secret";
let privateKey, env, profiles, stripeCalls, subscriptions, usage;

async function token(sub) {
  return new SignJWT({ email: `${sub.slice(0, 4)}@x.test` })
    .setProtectedHeader({ alg: "ES256", kid: "k1" })
    .setSubject(sub).setIssuer(`${SUPABASE_URL}/auth/v1`).setAudience("authenticated")
    .setIssuedAt().setExpirationTime("1h").sign(privateKey);
}

// Fake Supabase PostgREST + Stripe API behind global fetch.
function fakeFetch(realFetch) {
  return async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = (init.method || "GET").toUpperCase();

    if (url.origin === SUPABASE_URL) {
      const k = env.SUPABASE_SERVICE_ROLE_KEY;
      expect(init.headers.apikey).toBe(k);
      expect(init.headers.Authorization).toBe(k.startsWith("sb_") ? undefined : `Bearer ${k}`);
      if (url.pathname === "/rest/v1/profiles") {
        const [[col, cond]] = [...url.searchParams].filter(([k]) => k !== "select");
        const val = decodeURIComponent(cond.replace(/^eq\./, ""));
        const rows = profiles.filter((p) => String(p[col]) === val);
        if (method === "PATCH") {
          const patch = JSON.parse(init.body);
          rows.forEach((r) => Object.assign(r, patch));
        }
        return Response.json(rows);
      }
      if (url.pathname === "/rest/v1/rpc/increment_usage") {
        usage.push(JSON.parse(init.body));
        return Response.json(usage.length);
      }
      if (url.pathname === "/rest/v1/rpc/get_current_month_usage") return Response.json(usage.length);
    }

    if (url.origin === "https://api.stripe.com") {
      expect(init.headers.Authorization).toBe("Bearer sk_test_x");
      const params = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
      stripeCalls.push({ method, path: url.pathname, params, idem: init.headers["Idempotency-Key"] });
      if (url.pathname === "/v1/customers") return Response.json({ id: "cus_new" });
      if (url.pathname === "/v1/checkout/sessions") return Response.json({ url: "https://checkout.stripe.com/c/pay/cs_1" });
      const pm = url.pathname.match(/^\/v1\/prices\/(.+)$/);
      if (pm) return Response.json({ id: pm[1], unit_amount: { price_pro: 1200, price_pro_y: 9900, price_biz: 2900, price_biz_y: 24900 }[pm[1]], currency: "usd" });
      if (url.pathname === "/v1/billing_portal/sessions") return Response.json({ url: "https://billing.stripe.com/p/1" });
      const m = url.pathname.match(/^\/v1\/subscriptions\/(.+)$/);
      if (m) return subscriptions[m[1]] ? Response.json(subscriptions[m[1]]) : Response.json({ error: {} }, { status: 404 });
    }
    return realFetch(input, init);
  };
}

const call = async (method, path, { auth, json, body, headers = {} } = {}) => {
  const h = { ...headers };
  if (auth) h.Authorization = `Bearer ${auth}`;
  if (json) h["Content-Type"] = "application/json";
  const waits = [];
  const res = await worker.fetch(
    new Request(`https://site.test${path}`, { method, headers: h, body: json ? JSON.stringify(json) : body }),
    env,
    { waitUntil: (p) => waits.push(p) }
  );
  await Promise.all(waits);
  return res;
};

async function signedEvent(event, { secret = WHSEC, t = Math.floor(Date.now() / 1000) } = {}) {
  const payload = JSON.stringify(event);
  const sig = await signPayload(secret, t, payload);
  return { body: payload, headers: { "Stripe-Signature": `t=${t},v1=${sig}`, "Content-Type": "application/json" } };
}

const sub = (id, over = {}) => ({
  id, status: "active", customer: "cus_alice", metadata: { user_id: ALICE },
  items: { data: [{ price: { id: "price_pro" }, current_period_end: 1893456000 }] }, ...over,
});

let realFetch;
beforeAll(async () => {
  const kp = await generateKeyPair("ES256");
  privateKey = kp.privateKey;
  const jwk = { ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "ES256" };
  env = {
    SUPABASE_URL, JWKS_JSON: JSON.stringify({ keys: [jwk] }), SUPABASE_SERVICE_ROLE_KEY: "service-key",
    STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: WHSEC, STRIPE_PRICE_PRO_MONTHLY: "price_pro", STRIPE_PRICE_PRO_YEARLY: "price_pro_y", STRIPE_PRICE_BUSINESS_MONTHLY: "price_biz", STRIPE_PRICE_BUSINESS_YEARLY: "price_biz_y",
  };
  realFetch = globalThis.fetch;
});
beforeEach(() => {
  profiles = [
    { id: ALICE, email: "alice@x.test", tier: "free", is_premium: false, subscription_status: "inactive", stripe_customer_id: "cus_alice" },
    { id: BOB, email: "bob@x.test", tier: "free", is_premium: false, subscription_status: "inactive", stripe_customer_id: null },
  ];
  stripeCalls = []; subscriptions = {}; usage = [];
  globalThis.fetch = fakeFetch(realFetch);
});
afterEach(() => { globalThis.fetch = realFetch; });

describe("webhook signature", () => {
  it("accepts a valid signature and rejects tampering", async () => {
    const t = 1_700_000_000;
    const sig = await signPayload(WHSEC, t, '{"a":1}');
    await expect(verifyWebhook(WHSEC, '{"a":1}', `t=${t},v1=${sig}`, { now: t * 1000 })).resolves.toEqual({ a: 1 });
    await expect(verifyWebhook(WHSEC, '{"a":2}', `t=${t},v1=${sig}`, { now: t * 1000 })).rejects.toThrow(/Invalid signature/);
    await expect(verifyWebhook("other", '{"a":1}', `t=${t},v1=${sig}`, { now: t * 1000 })).rejects.toThrow(/Invalid signature/);
  });
  it("rejects replayed (old) events", async () => {
    const t = 1_700_000_000;
    const sig = await signPayload(WHSEC, t, "{}");
    await expect(verifyWebhook(WHSEC, "{}", `t=${t},v1=${sig}`, { now: (t + 301) * 1000 })).rejects.toThrow(/too old/);
  });
  it("route rejects unsigned requests", async () => {
    const res = await call("POST", "/api/billing/webhook", { body: "{}", headers: { "Content-Type": "application/json" } });
    expect(res.status).toBe(400);
    expect(profiles[0].tier).toBe("free");
  });
  it("route rejects a forged upgrade event", async () => {
    subscriptions.sub_1 = sub("sub_1");
    const ev = await signedEvent({ type: "customer.subscription.updated", data: { object: { id: "sub_1" } } }, { secret: "whsec_wrong" });
    expect((await call("POST", "/api/billing/webhook", ev)).status).toBe(400);
    expect(profiles[0].tier).toBe("free");
  });
});

describe("webhook sync", () => {
  it("upgrades on an active subscription, using Stripe's current state", async () => {
    subscriptions.sub_1 = sub("sub_1");
    // Event body claims something else; we must trust the re-fetched subscription.
    const ev = await signedEvent({ type: "customer.subscription.updated", data: { object: { id: "sub_1", status: "canceled" } } });
    expect((await call("POST", "/api/billing/webhook", ev)).status).toBe(200);
    expect(profiles[0]).toMatchObject({ tier: "pro", is_premium: true, subscription_status: "active", stripe_subscription_id: "sub_1" });
    expect(profiles[0].subscription_period_end).toBe("2030-01-01T00:00:00.000Z");
  });

  it("downgrades when the subscription is cancelled", async () => {
    Object.assign(profiles[0], { tier: "pro", is_premium: true, subscription_status: "active" });
    subscriptions.sub_1 = sub("sub_1", { status: "canceled" });
    const ev = await signedEvent({ type: "customer.subscription.deleted", data: { object: { id: "sub_1" } } });
    await call("POST", "/api/billing/webhook", ev);
    expect(profiles[0]).toMatchObject({ tier: "free", is_premium: false, subscription_status: "canceled" });
  });

  it("links an unlinked customer via the subscription's user id", async () => {
    subscriptions.sub_b = sub("sub_b", { customer: "cus_bob", metadata: { user_id: BOB } });
    const ev = await signedEvent({ type: "checkout.session.completed", data: { object: { subscription: "sub_b", client_reference_id: BOB } } });
    await call("POST", "/api/billing/webhook", ev);
    expect(profiles[1]).toMatchObject({ tier: "pro", stripe_customer_id: "cus_bob" });
  });

  it("maps the business price to the business tier", async () => {
    subscriptions.sub_1 = sub("sub_1", { items: { data: [{ price: { id: "price_biz" } }] } });
    await call("POST", "/api/billing/webhook", await signedEvent({ type: "customer.subscription.created", data: { object: { id: "sub_1" } } }));
    expect(profiles[0].tier).toBe("business");
  });

  it("maps yearly prices to their plan", async () => {
    subscriptions.sub_1 = sub("sub_1", { items: { data: [{ price: { id: "price_pro_y" } }] } });
    await call("POST", "/api/billing/webhook", await signedEvent({ type: "customer.subscription.created", data: { object: { id: "sub_1" } } }));
    expect(profiles[0].tier).toBe("pro");
  });

  it("does not grant a tier for an unknown price", async () => {
    subscriptions.sub_1 = sub("sub_1", { items: { data: [{ price: { id: "price_unknown" } }] } });
    await call("POST", "/api/billing/webhook", await signedEvent({ type: "customer.subscription.created", data: { object: { id: "sub_1" } } }));
    expect(profiles[0]).toMatchObject({ tier: "free", is_premium: false });
  });

  it("ignores unrelated events", async () => {
    const res = await call("POST", "/api/billing/webhook", await signedEvent({ type: "invoice.created", data: { object: {} } }));
    expect((await res.json()).ignored).toBe("invoice.created");
    expect(stripeCalls).toEqual([]);
  });
});

describe("checkout & portal", () => {
  it("creates a customer once and returns a checkout URL", async () => {
    const res = await call("POST", "/api/billing/checkout", { auth: await token(BOB), json: { plan: "pro" } });
    expect(await res.json()).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_1" });
    expect(stripeCalls[0]).toMatchObject({ path: "/v1/customers", idem: `customer-${BOB}` });
    expect(profiles[1].stripe_customer_id).toBe("cus_new");
    const session = stripeCalls[1].params;
    expect(session).toMatchObject({
      mode: "subscription", customer: "cus_new", client_reference_id: BOB,
      "line_items[0][price]": "price_pro", "subscription_data[metadata][user_id]": BOB,
      success_url: "https://site.test/?billing=success",
    });
  });

  it("uses the yearly price when asked", async () => {
    await call("POST", "/api/billing/checkout", { auth: await token(BOB), json: { plan: "business", interval: "year" } });
    expect(stripeCalls.at(-1).params["line_items[0][price]"]).toBe("price_biz_y");
  });

  it("/api/plans shows real amounts from Stripe", async () => {
    const body = await (await call("GET", "/api/plans")).json();
    expect(body.prices).toContainEqual({ plan: "pro", interval: "year", amount: 9900, currency: "usd" });
  });

  it("refuses checkout for users who already pay", async () => {
    Object.assign(profiles[0], { tier: "pro", subscription_status: "active" });
    expect((await call("POST", "/api/billing/checkout", { auth: await token(ALICE), json: {} })).status).toBe(409);
  });

  it("refuses unknown plans and signed-out users", async () => {
    expect((await call("POST", "/api/billing/checkout", { auth: await token(BOB), json: { plan: "free" } })).status).toBe(400);
    expect((await call("POST", "/api/billing/checkout", { json: {} })).status).toBe(401);
  });

  it("opens the billing portal for the user's own customer", async () => {
    const res = await call("POST", "/api/billing/portal", { auth: await token(ALICE) });
    expect((await res.json()).url).toBe("https://billing.stripe.com/p/1");
    expect(stripeCalls[0].params.customer).toBe("cus_alice");
  });

  it("reports billing as unavailable when not configured", async () => {
    const saved = env.STRIPE_SECRET_KEY;
    delete env.STRIPE_SECRET_KEY;
    try {
      expect((await call("POST", "/api/billing/checkout", { auth: await token(BOB), json: {} })).status).toBe(503);
      expect((await (await call("GET", "/api/plans")).json()).billingEnabled).toBe(false);
    } finally { env.STRIPE_SECRET_KEY = saved; }
  });
});

describe("plans & limits", () => {
  async function bigPdf(mb) {
    const doc = await PDFDocument.create();
    doc.addPage();
    const pad = new Uint8Array(mb * 1024 * 1024);
    for (let i = 0; i < pad.length; i += 65536) crypto.getRandomValues(pad.subarray(i, i + 65536)); // incompressible
    doc.attach(pad, "pad.bin");
    return doc.save();
  }
  const pdfForm = (bytes) => { const fd = new FormData(); fd.append("file", new File([bytes], "big.pdf")); return fd; };

  it("free users are capped at 10MB, Pro users get 25MB", async () => {
    const big = await bigPdf(12);
    expect((await call("POST", "/api/compress", { auth: await token(BOB), body: pdfForm(big) })).status).toBe(413);
    Object.assign(profiles[0], { tier: "pro", subscription_status: "active" });
    expect((await call("POST", "/api/compress", { auth: await token(ALICE), body: pdfForm(big) })).status).toBe(200);
  });

  it("a cancelled Pro subscription falls back to free limits", async () => {
    Object.assign(profiles[0], { tier: "pro", subscription_status: "canceled" });
    expect((await call("POST", "/api/compress", { auth: await token(ALICE), body: pdfForm(await bigPdf(12)) })).status).toBe(413);
  });

  it("counts usage for signed-in users only", async () => {
    const small = await bigPdf(0);
    await call("POST", "/api/compress", { auth: await token(ALICE), body: pdfForm(small) });
    await call("POST", "/api/compress", { body: pdfForm(small) });
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ p_user_id: ALICE, p_operation_type: "compress" });
  });

  it("tools still work with a stale token or a Supabase outage", async () => {
    const small = await bigPdf(0);
    expect((await call("POST", "/api/compress", { auth: "eyJhbGciOiJFUzI1NiJ9.e30.bad-signature-xx", body: pdfForm(small) })).status).toBe(200);
    globalThis.fetch = async () => new Response("down", { status: 503 });
    expect((await call("POST", "/api/compress", { auth: await token(ALICE), body: pdfForm(small) })).status).toBe(200);
  });

  it("/api/me reports plan, limits and usage", async () => {
    Object.assign(profiles[0], { tier: "pro", subscription_status: "active" });
    const body = await (await call("GET", "/api/me", { auth: await token(ALICE) })).json();
    expect(body).toMatchObject({ plan: "pro", planName: "Pro", limits: { maxFileMB: 25 }, billingEnabled: true });
  });
});

it("works with new-style sb_secret_ service keys", async () => {
  const saved = env.SUPABASE_SERVICE_ROLE_KEY;
  env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_abc";
  try {
    Object.assign(profiles[0], { tier: "pro", subscription_status: "active" });
    const body = await (await call("GET", "/api/me", { auth: await token(ALICE) })).json();
    expect(body.plan).toBe("pro");
  } finally { env.SUPABASE_SERVICE_ROLE_KEY = saved; }
});

it("formEncode builds Stripe's bracket syntax", () => {
  expect(formEncode({ a: 1, b: { c: [{ d: "x" }] }, n: null }).toString()).toBe("a=1&b%5Bc%5D%5B0%5D%5Bd%5D=x");
});
