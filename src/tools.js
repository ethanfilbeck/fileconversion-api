// PDF tool handlers. Each takes a Request and returns a Response.
import { PDFDocument } from "pdf-lib";
import { zipSync } from "fflate";
import { HttpError, fileResponse } from "./lib/http.js";
import { readPdfUploads, loadPdf, parseRanges, baseName, LIMITS } from "./lib/pdf.js";

// Every handler takes (request, env, plan) where plan.limits holds the caller's limits.

// POST /api/merge  — form fields: file (2+), in the order to merge
export async function merge(request, env, { limits = LIMITS } = {}) {
  const { files } = await readPdfUploads(request, { min: 2, limits });
  const out = await PDFDocument.create();
  let totalPages = 0;

  for (const f of files) {
    const src = await loadPdf(f.bytes, f.name, limits);
    totalPages += src.getPageCount();
    if (totalPages > limits.maxPages) {
      throw new HttpError(413, `Merged document would exceed ${limits.maxPages} pages`);
    }
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }

  const bytes = await out.save({ useObjectStreams: true });
  return fileResponse(bytes, "merged.pdf", "application/pdf");
}

// POST /api/split — fields: file, mode=range|each, pages="1-3,5" (range mode)
export async function split(request, env, { limits = LIMITS } = {}) {
  const { files, form } = await readPdfUploads(request, { max: 1, limits });
  const [{ name, bytes }] = files;
  const src = await loadPdf(bytes, name, limits);
  const pageCount = src.getPageCount();
  const mode = String(form.get("mode") || "range");
  const base = baseName(name);

  if (mode === "range") {
    const indices = parseRanges(form.get("pages"), pageCount);
    const out = await PDFDocument.create();
    (await out.copyPages(src, indices)).forEach((p) => out.addPage(p));
    const result = await out.save({ useObjectStreams: true });
    return fileResponse(result, `${base}-pages.pdf`, "application/pdf");
  }

  if (mode === "each") {
    // Build each single-page PDF and add it to the zip one at a time,
    // so we never hold two full copies of every page in memory.
    const entries = {};
    const width = String(pageCount).length;
    for (let i = 0; i < pageCount; i++) {
      const out = await PDFDocument.create();
      const [page] = await out.copyPages(src, [i]);
      out.addPage(page);
      entries[`${base}-page-${String(i + 1).padStart(width, "0")}.pdf`] = [
        await out.save({ useObjectStreams: true }),
        { level: 0 }, // PDFs are already compressed; storing is faster
      ];
    }
    return fileResponse(zipSync(entries), `${base}-pages.zip`, "application/zip");
  }

  throw new HttpError(400, 'mode must be "range" or "each"');
}

// POST /api/compress — field: file
// pdf-lib can't resample images, so this is structural optimization:
// object streams, dropped metadata, de-duplicated structure.
export async function compress(request, env, { limits = LIMITS } = {}) {
  const { files } = await readPdfUploads(request, { max: 1, limits });
  const [{ name, bytes }] = files;
  const src = await loadPdf(bytes, name, limits);

  src.setTitle("");
  src.setAuthor("");
  src.setSubject("");
  src.setKeywords([]);
  src.setProducer("");
  src.setCreator("");

  // Re-copying into a fresh document drops unreferenced objects.
  const out = await PDFDocument.create();
  (await out.copyPages(src, src.getPageIndices())).forEach((p) => out.addPage(p));
  let result = await out.save({ useObjectStreams: true });

  // Never hand back a bigger file than we received.
  const optimized = result.length < bytes.length;
  if (!optimized) result = bytes;

  const res = fileResponse(result, `${baseName(name)}-compressed.pdf`, "application/pdf");
  res.headers.set("X-Original-Size", String(bytes.length));
  res.headers.set("X-Compressed-Size", String(result.length));
  res.headers.set("Access-Control-Expose-Headers", "X-Original-Size, X-Compressed-Size");
  return res;
}
