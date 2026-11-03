// Billing: plan lookup, Stripe Checkout, Customer Portal, and the Stripe webhook.
//
// Source of truth: Stripe. The webhook re-fetches the subscription from Stripe
// on every event and writes its current state to profiles, so out-of-order or
// repeated events can't leave a user on the wrong plan.
import { HttpError } from "./lib/http.js";
import { getUser, requireUser } from "./lib/auth.js";
import { hasAdmin, getProfile, updateProfile, getMonthUsage } from "./lib/supabase.js";
import { hasStripe, stripe, verifyWebhook } from "./lib/stripe.js";
import { PLANS, PAID_STATUSES, planFromProfile, limitsFor } from "./lib/plans.js";

const UUID_RE = /^[0-9a-f-]{36}$/i;

// Work out who's calling and what they're allowed to do.
// optional=true: bad/missing tokens and account-service outages fall back to Free,
// so the PDF tools never break because of auth or billing problems.
export async function resolvePlan(request, env, { optional = false } = {}) {
  let user = null;
  if (optional) {
    try {
      user = await getUser(request, env);
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 401)) throw err;
    }
  } else {
    user = await requireUser(request, env);
  }

  let plan = "free";
  let profile = null;
  if (user && hasAdmin(env)) {
    try {
      profile = await getProfile(env, user.id);
      plan = planFromProfile(profile);
    } catch (err) {
      if (!optional) throw err;
      console.error("Plan lookup failed, using free", err?.message);
    }
  }
  return { user, plan, profile, limits: limitsFor(plan) };
}

function publicLimits(limits) {
  const mb = (n) => Math.round(n / 1024 / 1024);
  return {
    maxFileMB: mb(limits.maxFileBytes),
    maxTotalMB: mb(limits.maxTotalBytes),
    maxFiles: limits.maxFiles,
    maxPages: limits.maxPages,
    maxSavedFiles: limits.maxSavedFiles,
  };
}

// GET /api/me — who am I, what plan, what limits
export async function me(request, env) {
  const { user, plan, profile, limits } = await resolvePlan(request, env);
  let usageThisMonth = null;
  if (hasAdmin(env)) {
    usageThisMonth = await getMonthUsage(env, user.id).catch(() => null);
  }
  return Response.json({
    user,
    plan,
    planName: limits.name,
    subscriptionStatus: profile?.subscription_status || null,
    renewsAt: profile?.subscription_period_end || null,
    limits: publicLimits(limits),
    usageThisMonth,
    billingEnabled: billingReady(env),
  });
}

// GET /api/plans — public price list for the UI
export function plans(request, env) {
  return Response.json({
    billingEnabled: billingReady(env),
    plans: Object.fromEntries(Object.entries(PLANS).map(([id, l]) => [id, { name: l.name, ...publicLimits(l) }])),
  });
}

const billingReady = (env) => hasStripe(env) && hasAdmin(env) && Boolean(env.STRIPE_PRICE_PRO);

function requireBilling(env) {
  if (!billingReady(env)) throw new HttpError(503, "Billing isn't set up yet");
}

function priceForPlan(env, plan) {
  const price = { pro: env.STRIPE_PRICE_PRO, business: env.STRIPE_PRICE_BUSINESS }[plan];
  if (!price) throw new HttpError(400, "Unknown plan");
  return price;
}

function tierForPrice(env, priceId) {
  if (priceId && priceId === env.STRIPE_PRICE_BUSINESS) return "business";
  if (priceId && priceId === env.STRIPE_PRICE_PRO) return "pro";
  return null;
}

async function ensureCustomer(env, user, profile) {
  if (profile?.stripe_customer_id) return profile.stripe_customer_id;
  const customer = await stripe(
    env,
    "POST",
    "customers",
    { email: user.email || undefined, metadata: { user_id: user.id } },
    { idempotencyKey: `customer-${user.id}` } // two quick clicks can't create two customers
  );
  await updateProfile(env, `id=eq.${user.id}`, { stripe_customer_id: customer.id });
  return customer.id;
}

function siteUrl(request, env) {
  return env.SITE_URL || new URL(request.url).origin;
}

// POST /api/billing/checkout  { plan: "pro" } -> { url }
export async function checkout(request, env) {
  requireBilling(env);
  const { user, plan: currentPlan, profile } = await resolvePlan(request, env);
  const body = await request.json().catch(() => ({}));
  const wanted = body.plan || "pro";
  const price = priceForPlan(env, wanted);

  if (currentPlan !== "free") {
    throw new HttpError(409, "You already have a paid plan. Use Manage billing to change it.");
  }

  const customer = await ensureCustomer(env, user, profile);
  const site = siteUrl(request, env);
  const session = await stripe(env, "POST", "checkout/sessions", {
    mode: "subscription",
    customer,
    client_reference_id: user.id,
    line_items: [{ price, quantity: 1 }],
    subscription_data: { metadata: { user_id: user.id } },
    allow_promotion_codes: "true",
    success_url: `${site}/?billing=success`,
    cancel_url: `${site}/?billing=cancelled`,
  });
  return Response.json({ url: session.url });
}

// POST /api/billing/portal -> { url }
export async function portal(request, env) {
  requireBilling(env);
  const { profile } = await resolvePlan(request, env);
  if (!profile?.stripe_customer_id) throw new HttpError(404, "No billing account yet");
  const session = await stripe(env, "POST", "billing_portal/sessions", {
    customer: profile.stripe_customer_id,
    return_url: siteUrl(request, env),
  });
  return Response.json({ url: session.url });
}

// ---- Webhook ----

const HANDLED = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
]);

// POST /api/billing/webhook
export async function webhook(request, env) {
  if (!hasStripe(env) || !hasAdmin(env)) throw new HttpError(503, "Billing isn't set up yet");
  const payload = await request.text();
  if (payload.length > 512 * 1024) throw new HttpError(413, "Payload too large");
  const event = await verifyWebhook(env.STRIPE_WEBHOOK_SECRET, payload, request.headers.get("Stripe-Signature"));

  if (!HANDLED.has(event.type)) return Response.json({ received: true, ignored: event.type });

  const obj = event.data?.object || {};
  const subscriptionId = event.type === "checkout.session.completed" ? obj.subscription : obj.id;
  if (!subscriptionId) return Response.json({ received: true, ignored: "no subscription" });

  // Always read the latest state from Stripe instead of trusting event order.
  const sub = await stripe(env, "GET", `subscriptions/${encodeURIComponent(subscriptionId)}`);
  await syncSubscription(env, sub, obj.client_reference_id);
  return Response.json({ received: true });
}

export async function syncSubscription(env, sub, fallbackUserId) {
  const item = sub.items?.data?.[0];
  const tier = tierForPrice(env, item?.price?.id);
  const paid = PAID_STATUSES.has(sub.status) && tier !== null;
  const periodEnd = item?.current_period_end ?? sub.current_period_end;

  const patch = {
    tier: paid ? tier : "free",
    is_premium: paid,
    subscription_status: sub.status,
    stripe_subscription_id: sub.id,
    subscription_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
  };

  const customer = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
  let rows = customer ? await updateProfile(env, `stripe_customer_id=eq.${encodeURIComponent(customer)}`, patch) : [];

  // Customer not linked yet (e.g. created outside our checkout): link via user id.
  if (!rows?.length) {
    const userId = sub.metadata?.user_id || fallbackUserId;
    if (userId && UUID_RE.test(userId)) {
      rows = await updateProfile(env, `id=eq.${userId}`, { ...patch, stripe_customer_id: customer });
    }
  }
  if (!rows?.length) console.error("Webhook: no profile matched subscription", sub.id);
  return rows;
}
