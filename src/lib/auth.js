// Supabase auth for the Worker: verifies the user's access token.
//
// Supabase signs tokens with asymmetric keys published at a JWKS endpoint.
// We verify signatures locally (no network call per request once keys are
// cached). Older projects that still use the shared HS256 secret fall back to
// asking Supabase's /auth/v1/user endpoint to validate the token.
import { createRemoteJWKSet, createLocalJWKSet, jwtVerify, decodeProtectedHeader } from "jose";
import { HttpError } from "./http.js";

const jwksCache = new Map(); // per isolate

function getJwks(env) {
  if (env.JWKS_JSON) return createLocalJWKSet(JSON.parse(env.JWKS_JSON)); // tests
  const url = `${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`;
  if (!jwksCache.has(url)) {
    jwksCache.set(url, createRemoteJWKSet(new URL(url), { cacheMaxAge: 10 * 60 * 1000 }));
  }
  return jwksCache.get(url);
}

function bearer(request) {
  const h = request.headers.get("Authorization") || "";
  const m = h.match(/^Bearer ([A-Za-z0-9._-]{20,4096})$/);
  return m ? m[1] : null;
}

// Returns { id, email } or null when no token was sent. Throws 401 on a bad token.
export async function getUser(request, env) {
  const token = bearer(request);
  if (!token) return null;
  if (!env.SUPABASE_URL) throw new HttpError(500, "Auth is not configured");

  let alg;
  try {
    alg = decodeProtectedHeader(token).alg;
  } catch {
    throw new HttpError(401, "Invalid session, please sign in again");
  }

  if (alg === "HS256") return verifyViaSupabase(token, env);

  try {
    const { payload } = await jwtVerify(token, getJwks(env), {
      issuer: `${env.SUPABASE_URL}/auth/v1`,
      audience: "authenticated",
      algorithms: ["ES256", "RS256", "EdDSA"],
    });
    if (!payload.sub) throw new Error("no sub");
    return { id: payload.sub, email: payload.email || null };
  } catch {
    throw new HttpError(401, "Invalid or expired session, please sign in again");
  }
}

async function verifyViaSupabase(token, env) {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: env.SUPABASE_PUBLISHABLE_KEY || "" },
  });
  if (!res.ok) throw new HttpError(401, "Invalid or expired session, please sign in again");
  const user = await res.json();
  if (!user?.id) throw new HttpError(401, "Invalid session, please sign in again");
  return { id: user.id, email: user.email || null };
}

export async function requireUser(request, env) {
  const user = await getUser(request, env);
  if (!user) throw new HttpError(401, "Sign in to use this feature");
  return user;
}
