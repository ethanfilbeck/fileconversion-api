// PDF input handling: size limits, magic-byte checks, safe loading.
import { PDFDocument } from "pdf-lib";
import { HttpError } from "./http.js";
import { PLANS } from "./plans.js";

// Default (free) limits; callers pass the signed-in user's plan limits.
export const LIMITS = PLANS.free;
const mb = (n) => Math.round(n / 1024 / 1024);

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

export function isPdf(bytes) {
  // Spec allows the header within the first 1024 bytes.
  const window = bytes.subarray(0, Math.min(bytes.length, 1024));
  outer: for (let i = 0; i <= window.length - PDF_MAGIC.length; i++) {
    for (let j = 0; j < PDF_MAGIC.length; j++) {
      if (window[i + j] !== PDF_MAGIC[j]) continue outer;
    }
    return true;
  }
  return false;
}

// Read uploaded PDFs from a multipart form, enforcing limits before buffering.
export async function readPdfUploads(request, { min = 1, max, limits = LIMITS } = {}) {
  max = Math.min(max ?? limits.maxFiles, limits.maxFiles);
  const type = request.headers.get("Content-Type") || "";
  if (!type.includes("multipart/form-data")) {
    throw new HttpError(415, "Expected multipart/form-data");
  }
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > limits.maxTotalBytes + 1024 * 1024) {
    throw new HttpError(413, `Request too large (max ${mb(limits.maxTotalBytes)}MB total)`);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    throw new HttpError(400, "Malformed form data");
  }

  const files = form.getAll("file").filter((f) => f && typeof f === "object" && "arrayBuffer" in f);
  if (files.length < min) throw new HttpError(400, min === 1 ? "No file uploaded" : `Upload at least ${min} PDFs`);
  if (files.length > max) throw new HttpError(400, `Too many files (max ${max})`);

  let total = 0;
  for (const f of files) {
    if (f.size === 0) throw new HttpError(400, `"${f.name}" is empty`);
    if (f.size > limits.maxFileBytes) throw new HttpError(413, `"${f.name}" is over ${mb(limits.maxFileBytes)}MB`);
    total += f.size;
  }
  if (total > limits.maxTotalBytes) throw new HttpError(413, `Files total over ${mb(limits.maxTotalBytes)}MB`);

  const out = [];
  for (const f of files) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (!isPdf(bytes)) throw new HttpError(415, `"${f.name}" is not a PDF`);
    out.push({ name: f.name, bytes });
  }
  return { files: out, form, totalBytes: total };
}

export async function loadPdf(bytes, name = "file", limits = LIMITS) {
  let doc, pages;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
    // pdf-lib parses leniently; a missing page tree only surfaces here.
    pages = doc.getPageCount();
  } catch (err) {
    if (/encrypt/i.test(String(err?.message))) {
      throw new HttpError(422, `"${name}" is password-protected`);
    }
    throw new HttpError(422, `"${name}" could not be read (corrupted PDF?)`);
  }
  if (pages === 0) throw new HttpError(422, `"${name}" has no pages`);
  if (pages > limits.maxPages) throw new HttpError(413, `"${name}" has too many pages (max ${limits.maxPages})`);
  return doc;
}

// Parse "1-3, 5, 8-" into zero-based page indices (in order, de-duplicated).
export function parseRanges(spec, pageCount) {
  const text = String(spec || "").trim();
  if (!text) throw new HttpError(400, "Page range is required, e.g. 1-3,5");
  if (text.length > 200) throw new HttpError(400, "Page range too long");

  const seen = new Set();
  const result = [];
  for (const part of text.split(",")) {
    const m = part.trim().match(/^(\d{1,4})(?:\s*-\s*(\d{0,4}))?$/);
    if (!m) throw new HttpError(400, `Invalid range "${part.trim()}"`);
    const start = Number(m[1]);
    const end = m[2] === undefined ? start : m[2] === "" ? pageCount : Number(m[2]);
    if (start < 1 || end < start || end > pageCount) {
      throw new HttpError(400, `Range "${part.trim()}" is outside 1-${pageCount}`);
    }
    for (let p = start; p <= end; p++) {
      if (!seen.has(p)) {
        seen.add(p);
        result.push(p - 1);
      }
    }
  }
  return result;
}

export function baseName(name) {
  return String(name || "document").replace(/\.pdf$/i, "");
}
