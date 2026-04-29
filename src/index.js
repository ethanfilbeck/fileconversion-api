export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // =========================
    // ROOT ROUTE
    // =========================
    if (url.pathname === "/") {
      return new Response("FileConversion API is LIVE", {
        headers: { "Content-Type": "text/plain" },
      });
    }

    // =========================
    // HEALTH CHECK
    // =========================
    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    // =========================
    // UPLOAD → R2 + KV (FIXED ORDER)
    // =========================
    if (url.pathname === "/upload" && request.method === "POST") {
      const formData = await request.formData();
      const file = formData.get("file");

      if (!file) {
        return Response.json({ error: "No file uploaded" }, { status: 400 });
      }

      // safety check (MUST BE FIRST)
      if (file.size === 0) {
        return Response.json({ error: "Empty file" }, { status: 400 });
      }

      if (file.size > 10 * 1024 * 1024) {
        return Response.json({ error: "File too large (10MB max)" }, { status: 413 });
      }

      const contentType = file.type || "application/octet-stream";

      const safeName = file.name.replace(/[^a-zA-Z0-9.-]/g, "_");
      const fileKey = `${Date.now()}-${safeName}`;

      const arrayBuffer = await file.arrayBuffer();

      // 1. STORE IN R2 (MUST HAPPEN FIRST)
      await env.BUCKET.put(fileKey, arrayBuffer, {
        httpMetadata: { contentType },
      });

      // 2. STORE METADATA IN KV (FIXED AND REQUIRED)
      await env.DB.put(
        fileKey,
        JSON.stringify({
          fileKey,
          name: safeName,
          originalName: file.name,
          size: file.size,
          type: contentType,
          createdAt: Date.now(),
        })
      );

      return Response.json({
        message: "File stored successfully",
        file: {
          fileKey,
          name: safeName,
          size: file.size,
          type: contentType,
          url: `/file/${fileKey}`,
        },
      });
    }

    // =========================
    // DOWNLOAD FROM R2
    // =========================
    if (url.pathname.startsWith("/file/") && request.method === "GET") {
      const fileKey = url.pathname.replace("/file/", "");

      if (!fileKey) {
        return Response.json({ error: "Missing file key" }, { status: 400 });
      }

      const object = await env.BUCKET.get(fileKey);

      if (!object) {
        return Response.json({ error: "File not found" }, { status: 404 });
      }

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.etag);
      headers.set("content-disposition", `inline; filename="${fileKey}"`);

      return new Response(object.body, { headers });
    }

    // =========================
    // LIST FILES (KV → DASHBOARD)
    // =========================
    if (url.pathname === "/files" && request.method === "GET") {
      try {
        // 1. get list of keys from KV
        const list = await env.DB.list({ limit: 100 });

        // 2. fetch metadata for each key
        const files = await Promise.all(
          list.keys.map(async (key) => {
            const data = await env.DB.get(key.name);

            if (!data) return null;

            const parsed = JSON.parse(data);

            return {
              fileKey: parsed.fileKey,
              name: parsed.name,
              size: parsed.size,
              type: parsed.type,
              createdAt: parsed.createdAt,
              url: `/file/${parsed.fileKey}`,
            };
          })
        );

        // 3. remove null values
        const cleanFiles = files.filter(Boolean);

        // 4. return response
        return Response.json({
          files: cleanFiles,
        });

      } catch (err) {
        return Response.json(
          { error: "Failed to fetch files" },
          { status: 500 }
        );
      }
    }

    // =========================
    // DEFAULT 404
    // =========================
    return Response.json({ error: "Not found" }, { status: 404 });
  },
};
