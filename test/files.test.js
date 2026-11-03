import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import worker from "../src/index.js";
import { PLANS } from "../src/lib/plans.js";

const SUPABASE_URL = "https://proj.supabase.co";
let privateKey, otherKey, env;

// Minimal in-memory stand-ins for KV and R2.
function memoryKV() {
  const m = new Map();
  return {
    async put(k, v, o = {}) { m.set(k, { v, meta: o.metadata ?? null }); },
    async get(k) { return m.get(k)?.v ?? null; },
    async getWithMetadata(k) { const e = m.get(k); return e ? { value: e.v, metadata: e.meta } : { value: null, metadata: null }; },
    async delete(k) { m.delete(k); },
    async list({ prefix = "", limit = 1000 } = {}) {
      const keys = [...m.entries()].filter(([k]) => k.startsWith(prefix)).slice(0, limit).map(([name, e]) => ({ name, metadata: e.meta }));
      return { keys };
    },
  };
}
function memoryR2() {
  const m = new Map();
  return {
    async put(k, body, o = {}) { m.set(k, { bytes: new Uint8Array(await new Response(body).arrayBuffer()), o }); },
    async get(k) { const e = m.get(k); return e ? { body: e.bytes, etag: "x", writeHttpMetadata() {} } : null; },
    async delete(k) { m.delete(k); },
    has: (k) => m.has(k),
  };
}

async function token(sub, { key = privateKey, iss = `${SUPABASE_URL}/auth/v1`, exp = "1h" } = {}) {
  return new SignJWT({ email: `${sub}@x.test`, role: "authenticated" })
    .setProtectedHeader({ alg: "ES256", kid: "k1" })
    .setSubject(sub).setIssuer(iss).setAudience("authenticated").setIssuedAt().setExpirationTime(exp)
    .sign(key);
}

const call = (method, path, { auth, body } = {}) =>
  worker.fetch(new Request(`https://x.test${path}`, {
    method, body, headers: auth ? { Authorization: `Bearer ${auth}` } : {},
  }), env);

function form(name = "notes.pdf", text = "%PDF-1.4 hello") {
  const fd = new FormData();
  fd.append("file", new File([text], name, { type: "application/pdf" }));
  return fd;
}

beforeAll(async () => {
  const kp = await generateKeyPair("ES256");
  privateKey = kp.privateKey;
  otherKey = (await generateKeyPair("ES256")).privateKey;
  const jwk = { ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "ES256" };
  env = { SUPABASE_URL, JWKS_JSON: JSON.stringify({ keys: [jwk] }) };
});
beforeEach(() => { env.DB = memoryKV(); env.BUCKET = memoryR2(); });

describe("auth", () => {
  it("rejects requests with no token", async () => {
    expect((await call("GET", "/api/files")).status).toBe(401);
  });
  it("accepts a valid Supabase token", async () => {
    const res = await call("GET", "/api/me", { auth: await token("alice") });
    const body = await res.json();
    expect(body.user).toEqual({ id: "alice", email: "alice@x.test" });
    expect(body.plan).toBe("free");
  });
  it("rejects tokens signed by another key", async () => {
    expect((await call("GET", "/api/me", { auth: await token("alice", { key: otherKey }) })).status).toBe(401);
  });
  it("rejects tokens from another issuer", async () => {
    expect((await call("GET", "/api/me", { auth: await token("alice", { iss: "https://evil.supabase.co/auth/v1" }) })).status).toBe(401);
  });
  it("rejects expired tokens", async () => {
    const t = await new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: "k1" }).setSubject("alice")
      .setIssuer(`${SUPABASE_URL}/auth/v1`).setAudience("authenticated").setExpirationTime(Math.floor(Date.now() / 1000) - 60).sign(privateKey);
    expect((await call("GET", "/api/me", { auth: t })).status).toBe(401);
  });
  it("rejects garbage tokens", async () => {
    expect((await call("GET", "/api/me", { auth: "not.a.realtoken-at-all-xx" })).status).toBe(401);
  });
});

describe("my files", () => {
  it("uploads, lists, downloads and deletes", async () => {
    const alice = await token("alice");
    const up = await call("POST", "/api/files", { auth: alice, body: form("Report Q1.pdf") });
    expect(up.status).toBe(201);
    const { file } = await up.json();
    expect(file.name).toBe("Report_Q1.pdf");

    const list = await (await call("GET", "/api/files", { auth: alice })).json();
    expect(list.files.map((f) => f.id)).toEqual([file.id]);

    const dl = await call("GET", `/api/files/${file.id}`, { auth: alice });
    expect(dl.status).toBe(200);
    expect(await dl.text()).toBe("%PDF-1.4 hello");
    expect(dl.headers.get("Content-Disposition")).toBe('attachment; filename="Report_Q1.pdf"');

    expect((await call("DELETE", `/api/files/${file.id}`, { auth: alice })).status).toBe(204);
    expect(env.BUCKET.has(`u/alice/${file.id}`)).toBe(false);
    expect((await (await call("GET", "/api/files", { auth: alice })).json()).files).toEqual([]);
  });

  it("never lets one user see, download or delete another user's file", async () => {
    const alice = await token("alice"), bob = await token("bob");
    const { file } = await (await call("POST", "/api/files", { auth: alice, body: form() })).json();

    expect((await (await call("GET", "/api/files", { auth: bob })).json()).files).toEqual([]);
    expect((await call("GET", `/api/files/${file.id}`, { auth: bob })).status).toBe(404);
    expect((await call("DELETE", `/api/files/${file.id}`, { auth: bob })).status).toBe(404);
    expect(env.BUCKET.has(`u/alice/${file.id}`)).toBe(true);
  });

  it("rejects path-traversal style ids", async () => {
    const alice = await token("alice");
    expect((await call("GET", "/api/files/..%2F..%2Fu%2Fbob%2Fx", { auth: alice })).status).toBe(404);
  });

  it("enforces the per-user file limit", async () => {
    const alice = await token("alice");
    for (let i = 0; i < PLANS.free.maxSavedFiles; i++) {
      await env.DB.put(`files:alice:${i}`, "1", { metadata: { id: String(i), createdAt: i } });
    }
    expect((await call("POST", "/api/files", { auth: alice, body: form() })).status).toBe(409);
  });

  it("allows Authorization in CORS preflight", async () => {
    const res = await call("OPTIONS", "/api/files");
    expect(res.headers.get("Access-Control-Allow-Headers")).toMatch(/Authorization/);
  });
});
