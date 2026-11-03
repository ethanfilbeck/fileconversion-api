// Plan limits. Signed-out visitors and free accounts get "free".
// The Worker has 128MB of memory, so paid limits stay well below that.
const MB = 1024 * 1024;

export const PLANS = {
  free: {
    name: "Free",
    maxFileBytes: 10 * MB,
    maxTotalBytes: 25 * MB,
    maxFiles: 20,
    maxPages: 500,
    maxSavedFiles: 50,
  },
  pro: {
    name: "Pro",
    maxFileBytes: 25 * MB,
    maxTotalBytes: 40 * MB,
    maxFiles: 50,
    maxPages: 2000,
    maxSavedFiles: 500,
  },
};
PLANS.business = { ...PLANS.pro, name: "Business", maxSavedFiles: 1000 /* KV list() returns at most 1000 keys */ };

export const PAID_STATUSES = new Set(["active", "trialing", "past_due"]);

// Turn a profiles row into an effective plan id.
export function planFromProfile(profile) {
  if (!profile) return "free";
  if (!PAID_STATUSES.has(profile.subscription_status)) return "free";
  return PLANS[profile.tier] ? profile.tier : "free";
}

export function limitsFor(plan) {
  return PLANS[plan] || PLANS.free;
}
