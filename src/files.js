// "My files": per-user storage. R2 holds the bytes, KV holds a small index.
// Every key is prefixed with the user's id, and every lookup rebuilds the key
// from the verified token, so one user can never reach another user's files.
import { HttpError, safeFilename, fileResponse } from "./lib/http.js";
import { requireUser } from "./lib/auth.js";
import { PLANS } from "./lib/plans.js";

const mb = (n) => Math.round(n / 1024 / 1024);

const ID_RE = /^[0-9a-f-]{36}$/;
const objectKey = (uid, id) => `u/${uid}/${id}`;
const indexKey = (uid, id) => `files:${uid}:${id}`;

// POST /api/files — field: file
export async function uploadFile(request, env, plan = {}) {
  const user = plan.user || (await requireUser(request, env));
  const limits = plan.limits || PLANS.free;

  const existing = await env.DB.list({ prefix: `files:${user.id}:`, limit: limits.maxSavedFiles });
  if (existing.keys.length >= limits.maxSavedFiles) {
    throw new HttpError(409, `Your plan keeps up to ${limits.maxSavedFiles} files. Delete some or upgrade.`);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    throw new HttpError(400, "Malformed form data");
  }
  const file = form.get("file");
  if (!file || typeof file !== "object") throw new HttpError(400, "No file uploaded");
  if (file.size === 0) throw new HttpError(400, "Empty file");
  if (file.size > limits.maxFileBytes) throw new HttpError(413, `File too large (${mb(limits.maxFileBytes)}MB max on your plan)`);

  const id = crypto.randomUUID();
  const meta = {
    id,
    name: safeFilename(file.name, "file"),
    size: file.size,
    type: file.type || "application/octet-stream",
    createdAt: Date.now(),
  };

  await env.BUCKET.put(objectKey(user.id, id), file.stream(), {
    httpMetadata: { contentType: meta.type },
    customMetadata: { owner: user.id },
  });
  // Small metadata lives in the KV key's metadata, so listing needs no extra reads.
  await env.DB.put(indexKey(user.id, id), "1", { metadata: meta });

  return Response.json({ file: meta }, { status: 201 });
}

// GET /api/files
export async function listFiles(request, env) {
  const user = await requireUser(request, env);
  const list = await env.DB.list({ prefix: `files:${user.id}:`, limit: 1000 });
  const files = list.keys
    .map((k) => k.metadata)
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt);
  return Response.json({ files });
}

// GET /api/files/:id
export async function downloadFile(request, env, id) {
  const user = await requireUser(request, env);
  if (!ID_RE.test(id)) throw new HttpError(404, "File not found");

  const entry = await env.DB.getWithMetadata(indexKey(user.id, id));
  const object = entry?.metadata ? await env.BUCKET.get(objectKey(user.id, id)) : null;
  if (!object) throw new HttpError(404, "File not found");

  const res = fileResponse(object.body, entry.metadata.name, entry.metadata.type);
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}

// DELETE /api/files/:id
export async function deleteFile(request, env, id) {
  const user = await requireUser(request, env);
  if (!ID_RE.test(id)) throw new HttpError(404, "File not found");

  const entry = await env.DB.get(indexKey(user.id, id));
  if (!entry) throw new HttpError(404, "File not found");

  await env.BUCKET.delete(objectKey(user.id, id));
  await env.DB.delete(indexKey(user.id, id));
  return new Response(null, { status: 204 });
}
