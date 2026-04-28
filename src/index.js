export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Root route
    if (url.pathname === "/") {
      return new Response("FileConversion API is LIVE", {
        headers: { "Content-Type": "text/plain" },
      });
    }

    // Health check (useful later)
    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    // Default 404
    return Response.json(
      { error: "Not found" },
      { status: 404 }
    );
  },
};
