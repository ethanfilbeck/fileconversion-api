# PDFToolsHub

PDF tools on Cloudflare Workers. You can merge, split and compress PDFs. Files are processed in memory and sent straight back. Nothing is stored.

## API

| Route | Form fields | Returns |
|---|---|---|
| `POST /api/merge` | `file` (2–20 PDFs, in order) | `merged.pdf` |
| `POST /api/split` | `file`, `mode=range` + `pages=1-3,5` | one PDF with those pages |
| `POST /api/split` | `file`, `mode=each` | ZIP with one PDF per page |
| `POST /api/compress` | `file` | optimized PDF, plus `X-Original-Size` / `X-Compressed-Size` headers |
| `GET /health` | | `{ "status": "ok" }` |
| `GET /api/me` | *(signed in)* | `{ user: { id, email } }` |
| `GET /api/files` | *(signed in)* | your saved files |
| `POST /api/files` | *(signed in)* `file` | saves a file (10MB max, 50 files per user) |
| `GET /api/files/:id` | *(signed in)* | downloads one of your files |
| `DELETE /api/files/:id` | *(signed in)* | deletes one of your files |

Signed-in routes take `Authorization: Bearer <Supabase access token>`. The Worker checks the token's signature against your Supabase project's public keys. Files are stored under the user's id, so nobody can reach another person's files.

Limits: 10MB per file, 25MB per request, 500 pages. Errors come back as `{ "error": "..." }` with a 4xx status code. Internal errors never leak details.

The older `POST /upload` and `GET /file/:key` routes (R2 storage) still work. The public `/files` listing was removed because it exposed every uploaded file to anyone.

## Develop

```bash
npm install
npm test          # vitest
npm run dev       # http://localhost:8787 (UI + API)
npm run deploy    # wrangler deploy (needs `npx wrangler login` first)
```

## Layout

- `src/index.js`: router, error handling, legacy storage routes
- `src/tools.js`: merge / split / compress handlers
- `src/lib/pdf.js`: upload limits, PDF magic-byte check, safe loading, page-range parser
- `src/files.js`: My files (per-user R2 storage + KV index)
- `src/lib/auth.js`: Supabase token verification
- `src/lib/http.js`: CORS allowlist (`ALLOWED_ORIGINS`), security headers, safe filenames
- `public/index.html`: the tools UI, served by Workers Static Assets

## Notes

"Compress" is structural optimization: object streams and stripped metadata. pdf-lib can't resample images, so scanned or image-heavy PDFs may barely shrink. The endpoint never returns a file larger than the one it received.
