// Minimal Stripe client over fetch (the Node SDK isn't needed on Workers).
import { HttpError } from "./http.js";

export const hasStripe = (env) => Boolean(env.STRIPE_SECRET_KEY);

// Stripe expects form encoding with bracketed keys: a[b][0]=c
export function formEncode(obj, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") formEncode(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export async function stripe(env, method, path, params, { idempotencyKey } = {}) {
  const headers = {
    Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers,
    body: params && method !== "GET" ? formEncode(params) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("Stripe error", res.status, body?.error?.type, body?.error?.message);
    throw new HttpError(502, "Payment service error, please try again");
  }
  return body;
}

// ---- Webhook signature verification (Stripe-Signature: t=...,v1=...) ----

const enc = new TextEncoder();

function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signPayload(secret, timestamp, payload) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${timestamp}.${payload}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verifyWebhook(secret, payload, header, { toleranceSec = 300, now = Date.now() } = {}) {
  if (!secret) throw new HttpError(503, "Webhook not configured");
  if (!header) throw new HttpError(400, "Missing signature");

  let timestamp = null;
  const signatures = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2);
    if (k === "t") timestamp = Number(v);
    if (k === "v1" && v) signatures.push(v);
  }
  if (!timestamp || !signatures.length) throw new HttpError(400, "Malformed signature");
  if (Math.abs(now / 1000 - timestamp) > toleranceSec) throw new HttpError(400, "Signature too old");

  const expected = await signPayload(secret, timestamp, payload);
  if (!signatures.some((s) => timingSafeEqualHex(s, expected))) throw new HttpError(400, "Invalid signature");

  try {
    return JSON.parse(payload);
  } catch {
    throw new HttpError(400, "Invalid payload");
  }
}
