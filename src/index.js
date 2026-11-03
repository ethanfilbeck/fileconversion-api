// PDFToolsHub Worker — routes API requests. Static files in /public are
// served by Workers Static Assets before this code runs.
import { HttpError, finalize, jsonError, corsHeaders, safeFilename } from "./lib/http.js";
import { LIMITS } from "./lib/pdf.js";
import { merge, split, compress } from "./tools.js";
import { uploadFile, listFiles, downloadFile, deleteFile } from "./files.js";
import { requireUser } from "./lib/auth.js";

const ROUTES = {
  "POST /api/merge": merge,
  "POST /api/split": split,
  "POST /api/compress": compress,
  "GET /health": () => Response.json({ status: "ok" }),
  "POST /upload": (req, env) => upload(req, env),
  // Public, non-secret settings the browser needs to start Supabase auth.
  "GET /api/config": (req, env) =>
    Response.json({ supabaseUrl: env.SUPABASE_URL || null, supabaseKey: env.SUPABASE_PUBLISHABLE_KEY || null }),
  "GET /api/me": async (req, env) => Response.json({ user: await requireUser(req, env) }),
  "GET /api/files": listFiles,
  "POST /api/files": uploadFile,
};

// Routes with an id in the path: /api/files/:id
const FILE_ROUTES = { GET: downloadFile, DELETE: deleteFile };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Tolerate a trailing slash ("/upload/") — the old frontend sends one.
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;

    if (request.method === "OPTIONS") {
      return finalize(new Response(null, { status: 204, headers: corsHeaders(request, env) }), request, env);
    }

    let response;
    try {
      const handler = ROUTES[`${request.method} ${path}`];
      if (handler) {
        response = await handler(request, env);
      } else if (path.startsWith("/api/files/") && FILE_ROUTES[request.method]) {
        response = await FILE_ROUTES[request.method](request, env, path.slice("/api/files/".length));
      } else if (request.method === "GET" && path.startsWith("/file/")) {
        response = await download(path.slice("/file/".length), env);
      } else {
        response = jsonError(404, "Not found");
      }
    } catch (err) {
      if (err instanceof HttpError) {
        response = jsonError(err.status, err.message);
      } else {
        console.error("Unhandled error", err?.stack || err);
        response = jsonError(500, "Something went wrong processing your file");
      }
    }
    return finalize(response, request, env);
  },
};

// ---- Legacy storage routes (kept so existing links keep working) ----

async function upload(request, env) {
  let form;
  try {
    form = await request.formData();
  } catch {
    throw new HttpError(400, "Malformed form data");
  }
  const file = form.get("file");
  if (!file || typeof file !== "object") throw new HttpError(400, "No file uploaded");
  if (file.size === 0) throw new HttpError(400, "Empty file");
  if (file.size > LIMITS.maxFileBytes) throw new HttpError(413, "File too large (10MB max)");

  const contentType = file.type || "application/octet-stream";
  const name = safeFilename(file.name, "upload");
  const fileKey = `${crypto.randomUUID()}-${name}`; // unguessable, unlike Date.now()

  await env.BUCKET.put(fileKey, await file.arrayBuffer(), { httpMetadata: { contentType } });
  await env.DB.put(
    fileKey,
    JSON.stringify({ fileKey, name, size: file.size, type: contentType, createdAt: Date.now() }),
    { expirationTtl: 60 * 60 * 24 } // metadata expires after 24h
  );

  return Response.json({
    message: "File stored successfully",
    fileKey, // top-level for the old frontend
    file: { fileKey, name, size: file.size, type: contentType, url: `/file/${fileKey}` },
  });
}

async function download(rawKey, env) {
  const fileKey = decodeURIComponent(rawKey);
  if (!/^[a-zA-Z0-9._-]{1,200}$/.test(fileKey)) throw new HttpError(400, "Invalid file key");
  const object = await env.BUCKET.get(fileKey);
  if (!object) throw new HttpError(404, "File not found");

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.etag);
  headers.set("Content-Disposition", `attachment; filename="${safeFilename(fileKey)}"`);
  headers.set("Cache-Control", "private, no-store");
  return new Response(object.body, { headers });
}
