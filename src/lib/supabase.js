// Server-side Supabase access with the service-role key (never sent to browsers).
// Uses PostgREST over fetch so the Worker bundle stays small.
import { HttpError } from "./http.js";

function headers(env, extra = {}) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

export const hasAdmin = (env) => Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);

async function rest(env, path, init = {}) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: headers(env, init.headers) });
  if (!res.ok) {
    console.error("Supabase error", res.status, await res.text().catch(() => ""));
    throw new HttpError(502, "Account service is unavailable, try again shortly");
  }
  return res.status === 204 ? null : res.json();
}

const PROFILE_COLUMNS = "id,email,tier,subscription_status,subscription_period_end,stripe_customer_id,stripe_subscription_id";

export async function getProfile(env, userId) {
  const rows = await rest(env, `profiles?id=eq.${encodeURIComponent(userId)}&select=${PROFILE_COLUMNS}`);
  return rows[0] || null;
}

export async function updateProfile(env, filter, patch) {
  // filter is a trusted PostgREST filter built by our code, e.g. "id=eq.<uuid>"
  const rows = await rest(env, `profiles?${filter}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
  return rows;
}

export async function incrementUsage(env, userId, operation, bytes) {
  return rest(env, "rpc/increment_usage", {
    method: "POST",
    body: JSON.stringify({ p_user_id: userId, p_operation_type: operation, p_file_size_bytes: bytes }),
  });
}

export async function getMonthUsage(env, userId) {
  return rest(env, "rpc/get_current_month_usage", {
    method: "POST",
    body: JSON.stringify({ p_user_id: userId }),
  });
}
