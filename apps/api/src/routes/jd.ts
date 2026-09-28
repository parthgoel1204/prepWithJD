import { Buffer } from "node:buffer";
import { Router, type Request, type Response } from "express";
import multer from "multer";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import mammoth from "mammoth";
import { asyncH, HttpError } from "../lib/http";
import { requireAuth } from "../middleware/auth";

// Mirrors the create-kit jd cap in routes/kits.ts: text over this is rejected
// (413 TEXT_TOO_LONG), never silently truncated, so what the user reviews here
// is exactly what the pipeline will be fed.
const MAX_JD_CHARS = 50_000;
// Extracted text under this is almost certainly a scanned/image-only PDF.
const MIN_TEXT_CHARS = 50;
// Memory storage keeps the file in RAM for the duration of the upload; nothing
// is ever written to disk and file contents are never logged.
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const UPLOAD_FIELD = "file";
const ALLOWED_EXT_RE = /\.([a-z0-9]+)$/i;

// Magic-byte signatures (checked against the actual bytes, not extension/mime):
// PDF begins "%PDF-", DOCX is a ZIP beginning with "PK\x03\x04" (stored-entry mode).
const PDF_MAGIC = Buffer.from("%PDF-", "latin1");
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

function fileExtension(name: string): string | null {
  const m = ALLOWED_EXT_RE.exec(name);
  return m ? m[1]!.toLowerCase() : null;
}

function detectKind(buffer: Buffer): "pdf" | "docx" | null {
  if (buffer.length >= PDF_MAGIC.length && buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) return "pdf";
  if (buffer.length >= ZIP_MAGIC.length && buffer.subarray(0, ZIP_MAGIC.length).equals(ZIP_MAGIC)) return "docx";
  return null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = fileExtension(file.originalname);
    if (ext !== "pdf" && ext !== "docx") {
      cb(new HttpError(400, "UNSUPPORTED_FILE_TYPE", "Only .pdf and .docx files are supported"));
      return;
    }
    cb(null, true);
  },
});

/**
 * Extract text from a PDF buffer. pdf-parse bundles pdf.js 1.x, which prints a
 * "Warning: Indexing all PDF objects" line per document (plus worker/intro
 * noise) straight to the console. Those lines are harmless but would spam the
 * API logs, so coarser console output is suppressed for the in-flight parse.
 */
async function parsePdf(buffer: Buffer): Promise<string> {
  const dropPdfjsNoise = (...args: unknown[]) => {
    const msg = typeof args[0] === "string" ? args[0] : "";
    if (msg.startsWith("Warning:") || msg.startsWith("Info:")) return;
    console.warn(...args);
  };
  const prevLog = console.log;
  const prevWarn = console.warn;
  console.log = dropPdfjsNoise as typeof console.log;
  console.warn = dropPdfjsNoise as typeof console.warn;
  try {
    const data = await pdfParse(buffer);
    return data?.text ?? "";
  } finally {
    console.log = prevLog;
    console.warn = prevWarn;
  }
}

async function parseDocx(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

/** Normalize extracted text: strip null bytes, unify EOLs, collapse blank runs, trim. */
function normalizeJdText(raw: string): string {
  return raw
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const jdRouter = Router();
jdRouter.use(requireAuth);

// Extract JD text from an uploaded .pdf/.docx. Returns only { text }; it does
// not create anything. The client drops the text into the editable JD field and
// creates a kit via the normal flow, so the pipeline is fed identical input.
jdRouter.post(
  "/extract",
  upload.single(UPLOAD_FIELD),
  asyncH(async (req: Request, res: Response) => {
    const file = req.file;
    if (!file) {
      throw new HttpError(400, "NO_FILE", `Attach a .pdf or .docx file with field name "${UPLOAD_FIELD}"`);
    }

    const ext = fileExtension(file.originalname);
    const kind = detectKind(file.buffer);
    if (!kind || kind !== ext) {
      throw new HttpError(
        400,
        "UNSUPPORTED_FILE_TYPE",
        "File contents don't match a .pdf/.docx signature — only .pdf and .docx files are supported",
      );
    }

    let raw: string;
    try {
      raw = kind === "pdf" ? await parsePdf(file.buffer) : await parseDocx(file.buffer);
    } catch {
      throw new HttpError(
        422,
        "UNREADABLE_FILE",
        "This file is corrupt, password-protected, or in an unexpected format",
      );
    }

    const text = normalizeJdText(raw);
    if (text.length < MIN_TEXT_CHARS) {
      throw new HttpError(
        422,
        "NO_TEXT_FOUND",
        "No readable text found. If this is a scanned PDF, paste the text manually.",
      );
    }
    if (text.length > MAX_JD_CHARS) {
      throw new HttpError(
        413,
        "TEXT_TOO_LONG",
        `The extracted JD is ${text.length.toLocaleString("en-US")} characters, over the ${MAX_JD_CHARS.toLocaleString("en-US")}-character limit`,
      );
    }

    res.json({ text });
  }),
);

// multer signals upload problems with MulterError (not HttpError); map them to
// clean JSON here so the global handler doesn't turn them into 500s.
jdRouter.use((err: unknown, _req: Request, res: Response, next: (e?: unknown) => void) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({ error: "FILE_TOO_LARGE", message: "File is too large (5 MB limit)" });
    } else {
      res.status(400).json({ error: "BAD_UPLOAD", message: `Upload is missing the "${UPLOAD_FIELD}" file field` });
    }
    return;
  }
  next(typeof err === "undefined" ? undefined : err);
});