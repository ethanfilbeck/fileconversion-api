import { describe, it, expect } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { unzipSync } from "fflate";
import worker from "../src/index.js";
import { parseRanges, isPdf } from "../src/lib/pdf.js";

const env = { ALLOWED_ORIGINS: "https://good.example" };

async function makePdf(pages, title = "Test") {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([300, 300]);
    p.drawText(`${title} page ${i + 1} `.repeat(20), { x: 10, y: 150, size: 8, font });
  }
  return doc.save({ useObjectStreams: false });
}

function post(path, files, fields = {}, headers = {}) {
  const fd = new FormData();
  for (const [name, bytes] of files) fd.append("file", new File([bytes], name, { type: "application/pdf" }));
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return worker.fetch(new Request(`https://x.test${path}`, { method: "POST", body: fd, headers }), env);
}

const pageCount = async (res) => (await PDFDocument.load(new Uint8Array(await res.arrayBuffer()))).getPageCount();

describe("merge", () => {
  it("merges PDFs in order", async () => {
    const res = await post("/api/merge", [["a.pdf", await makePdf(2)], ["b.pdf", await makePdf(3)]]);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="merged.pdf"');
    expect(await pageCount(res)).toBe(5);
  });

  it("requires two files", async () => {
    const res = await post("/api/merge", [["a.pdf", await makePdf(1)]]);
    expect(res.status).toBe(400);
  });

  it("rejects non-PDF bytes", async () => {
    const res = await post("/api/merge", [["a.pdf", await makePdf(1)], ["evil.pdf", new TextEncoder().encode("<html>hi</html>")]]);
    expect(res.status).toBe(415);
    expect((await res.json()).error).toMatch(/not a PDF/);
  });

  it("rejects corrupted PDFs with 422, not 500", async () => {
    const junk = new TextEncoder().encode("%PDF-1.7\n" + "garbage ".repeat(50));
    const res = await post("/api/merge", [["a.pdf", await makePdf(1)], ["bad.pdf", junk]]);
    expect(res.status).toBe(422);
  });
});

describe("split", () => {
  it("extracts a page range", async () => {
    const res = await post("/api/split", [["doc.pdf", await makePdf(6)]], { mode: "range", pages: "1-2, 5" });
    expect(res.status).toBe(200);
    expect(await pageCount(res)).toBe(3);
  });

  it("splits every page into a zip", async () => {
    const res = await post("/api/split", [["doc.pdf", await makePdf(3)]], { mode: "each" });
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    const entries = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(entries)).toEqual(["doc-page-1.pdf", "doc-page-2.pdf", "doc-page-3.pdf"]);
  });

  it("rejects out-of-range pages", async () => {
    const res = await post("/api/split", [["doc.pdf", await makePdf(2)]], { mode: "range", pages: "3" });
    expect(res.status).toBe(400);
  });
});

describe("compress", () => {
  it("never returns a larger file and reports sizes", async () => {
    const input = await makePdf(4);
    const res = await post("/api/compress", [["doc.pdf", input]]);
    expect(res.status).toBe(200);
    const out = new Uint8Array(await res.arrayBuffer());
    expect(out.length).toBeLessThanOrEqual(input.length);
    expect(Number(res.headers.get("X-Original-Size"))).toBe(input.length);
    expect(await PDFDocument.load(out)).toBeTruthy();
  });
});

describe("http hardening", () => {
  it("sets security headers and CORS only for allowed origins", async () => {
    const ok = await worker.fetch(new Request("https://x.test/health", { headers: { Origin: "https://good.example" } }), env);
    expect(ok.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe("https://good.example");
    const bad = await worker.fetch(new Request("https://x.test/health", { headers: { Origin: "https://evil.example" } }), env);
    expect(bad.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("errors carry CORS headers too", async () => {
    const res = await worker.fetch(new Request("https://x.test/nope", { headers: { Origin: "https://good.example" } }), env);
    expect(res.status).toBe(404);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://good.example");
  });

  it("sanitizes filenames in Content-Disposition", async () => {
    const res = await post("/api/split", [['a"\r\nX-Evil: 1.pdf', await makePdf(1)]], { mode: "range", pages: "1" });
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment; filename="[A-Za-z0-9._-]+"$/);
  });

  it("rejects non-multipart bodies", async () => {
    const res = await worker.fetch(new Request("https://x.test/api/merge", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } }), env);
    expect(res.status).toBe(415);
  });
});

describe("parseRanges", () => {
  it("handles open ranges and de-duplicates", () => {
    expect(parseRanges("2-, 1, 2", 4)).toEqual([1, 2, 3, 0]);
  });
  it("rejects garbage fast (no regex backtracking)", () => {
    const t = Date.now();
    expect(() => parseRanges("1".repeat(150) + "x", 10)).toThrow();
    expect(Date.now() - t).toBeLessThan(50);
  });
});

it("isPdf finds header within first 1KB", () => {
  expect(isPdf(new TextEncoder().encode("   %PDF-1.4"))).toBe(true);
  expect(isPdf(new TextEncoder().encode("PK\u0003\u0004"))).toBe(false);
});
