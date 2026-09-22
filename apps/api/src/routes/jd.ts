import { Router, type Request, type Response } from "express";
import multer from "multer";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import { asyncH, HttpError } from "../lib/http";
import { requireAuth } from "../middleware/auth";

// Mirrors the kit input schema's jd cap in routes/kits.ts so a huge file can
// never blow past the persisted-jd limit — it is truncated here instead.
const MAX_JD_CHARS = 50_000;
// Memory storage keeps the whole upload in RAM for the duration of the request.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const UPLOAD_FIELD = "file";
const PDF_RE = /\.pdf$/i;
const DOCX_RE = /\.docx$/i;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!(PDF_RE.test(file.originalname) || DOCX_RE.test(file.originalname))) {
      cb(new HttpError(400, "UNSUPPORTED_FILE", "Only .pdf and .docx files are supported"));
      return;
    }
    cb(null, true);
  },
});

/**
 * Extract text from a PDF buffer. pdf-parse bundles pdf.js 1.x, which prints a
 * "Warning: Indexing all PDF objects" line per document (and worker/intro
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

/** Light normalization: unify line endings, drop trailing space, cap blank runs. */
function normalizeJdText(raw: string): string {
  return raw.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export const jdRouter = Router();
jdRouter.use(requireAuth);

// Feed a job-description file through to text. Returns the extracted text plus
// the source file name; the client drops it into the (editable) JD field and
// saves a kit as usual — the pipeline is fed the same text either way.
jdRouter.post(
  "/extract",
  upload.single(UPLOAD_FIELD),
  asyncH(async (req: Request, res: Response) => {
    const file = req.file;
    if (!file) {
      throw new HttpError(400, "NO_FILE", `Attach a .pdf or .docx file with field name "${UPLOAD_FIELD}"`);
    }

    let text: string;
    try {
      text = PDF_RE.test(file.originalname) ? await parsePdf(file.buffer) : await parseDocx(file.buffer);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(
        422,
        "FILE_PARSE_FAILED",
        `Could not read "${file.originalname}" — it may be corrupt, encrypted, or in an unexpected format.`,
      );
    }

    text = normalizeJdText(text);
    if (!text) {
      throw new HttpError(
        422,
        "NO_TEXT_EXTRACTED",
        `No readable text found in "${file.originalname}" — it may be a scanned image (no text layer) or an empty document.`,
      );
    }

    const truncated = text.length > MAX_JD_CHARS;
    const body = truncated ? text.slice(0, MAX_JD_CHARS) : text;

    res.json({ file_name: file.originalname, chars: body.length, truncated, text: body });
  }),
);

// multer signals upload problems with MulterError (not HttpError); map them to
// clean JSON here so the global handler doesn't turn them into 500s.
jdRouter.use((err: unknown, _req: Request, res: Response, next: (e?: unknown) => void) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({ error: "FILE_TOO_LARGE", message: "File is too large (10 MB limit)" });
    } else {
      res.status(400).json({ error: "BAD_UPLOAD", message: `Upload is missing the "${UPLOAD_FIELD}" file field` });
    }
    return;
  }
  next(typeof err === "undefined" ? undefined : err);
});