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

| `GET /api/plans` | | plan names and limits, and whether billing is on |
| `POST /api/billing/checkout` | *(signed in)* JSON `{ "plan": "pro" }` | `{ url }` for Stripe Checkout |
| `POST /api/billing/portal` | *(signed in)* | `{ url }` for the Stripe customer portal |
| `POST /api/billing/webhook` | Stripe only (signed) | syncs the subscription into `profiles` |

Signed-in routes take `Authorization: Bearer <Supabase access token>`. The Worker checks the token's signature against your Supabase project's public keys. Files are stored under the user's id, so nobody can reach another person's files.

Limits: 10MB per file, 25MB per request, 500 pages. Errors come back as `{ "error": "..." }` with a 4xx status code. Internal errors never leak details.

The older `POST /upload` and `GET /file/:key` routes (R2 storage) still work. The public `/files` listing was removed because it exposed every uploaded file to anyone.

## Plans

| | Free (and signed out) | Pro | Business |
|---|---|---|---|
| Per file | 10MB | 25MB | 25MB |
| Per job | 25MB | 40MB | 40MB |
| Pages | 500 | 2,000 | 2,000 |
| Saved files | 50 | 500 | 1,000 |

Limits live in `src/lib/plans.js`. A user's plan comes from `profiles.tier`, and only counts while `subscription_status` is active, trialing or past_due. Only the Stripe webhook can change it: users can't edit their own profile row. Tool runs by signed-in users are counted with `increment_usage`.

## Billing setup (one time)

Billing stays off (the routes return 503) until these are set in Cloudflare under Worker → Settings → Variables and Secrets:

| Name | Type | Where to get it |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Secret | Supabase → Project Settings → API keys → `service_role` |
| `STRIPE_SECRET_KEY` | Secret | Stripe → Developers → API keys (`sk_test_...` while testing) |
| `STRIPE_WEBHOOK_SECRET` | Secret | Stripe → Developers → Webhooks → your endpoint → Signing secret |
| `STRIPE_PRICE_*` (4) | in `wrangler.toml` | monthly and yearly price ids for Pro and Business (test ids now; swap for live at launch) |

Webhook endpoint: `https://fileconversion-api.ethanfilbeck.workers.dev/api/billing/webhook`. Send these events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`.

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
- `src/billing.js`: plan lookup, checkout, portal, webhook
- `src/lib/plans.js`: plan limits
- `src/lib/stripe.js`: Stripe API client + webhook signature check
- `src/lib/supabase.js`: server-side Supabase (service role) helpers
- `src/lib/auth.js`: Supabase token verification
- `src/lib/http.js`: CORS allowlist (`ALLOWED_ORIGINS`), security headers, safe filenames
- `public/index.html`: the tools UI, served by Workers Static Assets

## Notes

"Compress" is structural optimization: object streams and stripped metadata. pdf-lib can't resample images, so scanned or image-heavy PDFs may barely shrink. The endpoint never returns a file larger than the one it received.
