/**
 * JD-upload verification against a REAL MongoDB + the REAL Express API.
 *
 * Spawns the API on an ephemeral port, registers a throwaway user, then probes
 * POST /api/jd/extract with fixtures from tooling/fixtures (text PDF, image-only
 * PDF, corrupt PDF, password-protected PDF) plus in-memory DOCX files, a renamed
 * executable (magic-byte rejection) and an oversized upload. The test user is
 * deleted from Atlas at the end.
 *
 * Run: npm run verify:upload   (requires MONGODB_URI set in apps/api/.env)
 */
import { spawn, type ChildProcess } from "node:child_process";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { connectDb, disconnectDb, models } from "@prepwithjd/pipeline";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(ROOT, "tooling", "fixtures");
const API_PORT = 4120;
const API = `http://127.0.0.1:${API_PORT}`;
const EMAIL = `jd-upload-${Date.now()}@test.local`;
const MIN_TEXT_CHARS = 50;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

try {
  process.loadEnvFile(join(ROOT, "apps/api/.env"));
} catch {
  /* no .env — the API spawn below will fail loudly; e2e behaves the same */
}

let api: ChildProcess | null = null;
let cookie = "";

const results: string[] = [];
const check = (label: string, pass: boolean, detail = "") => {
  results.push(`${pass ? "PASS" : "FAIL"} — ${label}${detail ? ` (${detail})` : ""}`);
};

function killTree(child: ChildProcess | null): void {
  if (!child) return;
  try {
    if (child.pid) process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGKILL");
  }
}

function startApi(): Promise<void> {
  return new Promise((resolveP, reject) => {
    api = spawn("npx", ["tsx", "apps/api/src/index.ts"], {
      cwd: ROOT,
      env: { ...process.env, API_PORT: String(API_PORT) },
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
    });
    api.stdout?.on("data", (d) => d.toString().includes("[api] listening") && resolveP());
    api.on("error", reject);
    setTimeout(() => {
      if (api && !api.killed) api.kill("SIGKILL");
      reject(new Error("API didn't start"));
    }, 40_000);
  });
}

async function apiCall<T>(path: string, opts: RequestInit = {}): Promise<{ status: number; json: T }> {
  const headers = new Headers(opts.headers as HeadersInit | undefined);
  if (opts.body) headers.set("Content-Type", "application/json");
  if (cookie) headers.set("Cookie", cookie);
  const res = await fetch(`${API}${path}`, { ...opts, headers });
  const set = res.headers.getSetCookie?.() ?? [];
  const sid = set.find((c) => c.startsWith("sid="));
  if (sid) cookie = sid.split(";")[0];
  const json = (await res.json().catch(() => null)) as T;
  return { status: res.status, json };
}

// --- tiny deterministic fixture builders (no binary fixtures committed) ---

let crcTable: Int32Array | null = null;
function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const u16 = (n: number) => Buffer.from([n & 0xff, (n >>> 8) & 0xff]);
const u32 = (n: number) => Buffer.from([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);

/** Minimal stored (uncompressed) ZIP, enough for mammoth to open. */
function buildZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const files: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.concat([
      u32(0x04034b50), // local file header signature
      u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length),
      u16(nameBuf.length), u16(0),
      nameBuf,
      data,
    ]);
    files.push(local);
    central.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(data.length), u32(data.length),
        u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset),
        nameBuf,
      ]),
    );
    offset += local.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralBuf.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...files, centralBuf, eocd]);
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildDocx(text: string): Buffer {
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${text
    .split(/\n/)
    .map((line) => `<w:p><w:r><w:t>${escapeXml(line)}</w:t></w:r></w:p>`)
    .join("")}</w:body></w:document>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\
<Default Extension="xml" ContentType="application/xml"/>\
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>\
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>\
</Relationships>`;
  return buildZip([
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(rels, "utf8") },
    { name: "word/document.xml", data: Buffer.from(doc, "utf8") },
  ]);
}

// --- fixture sources ---
// PDFs are committed under tooling/fixtures (generated with LibreOffice and
// ghostscript, which produce output that pdf.js v1.10 actually parses).
// DOCX files are built in-memory (deterministic ZIPs mammoth can open).

const LONG_TEXT =
  "prepWithJD upload verification: senior backend engineer, distributed systems, high-throughput services and ownership.";
const VALID_PDF = readFileSync(join(FIXTURES, "valid.pdf"));
const EMPTY_PDF = readFileSync(join(FIXTURES, "empty.pdf"));
const CORRUPT_PDF = readFileSync(join(FIXTURES, "corrupt.pdf"));
const ENCRYPTED_PDF = readFileSync(join(FIXTURES, "encrypted.pdf"));
const LONG_DOCX = buildDocx(`Paragraph one.\n\n\n\n\nParagraph two.\n${LONG_TEXT}`);
const SHORT_DOCX = buildDocx("Hi");
const FAKE_EXE = Buffer.concat([Buffer.from([0x4d, 0x5a, 0x90, 0x00]), Buffer.from("MZ executable payload ".repeat(40), "latin1")]);
const OVER_SIZED = Buffer.concat([Buffer.from("%PDF-1.7\n", "latin1"), Buffer.alloc(MAX_UPLOAD_BYTES + 1024, 0x41)]);

// --- upload helpers ---

async function upload(name: string, buffer: Buffer): Promise<{ status: number; json: Record<string, unknown> }> {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: "application/octet-stream" }), name);
  const res = await fetch(`${API}/api/jd/extract`, {
    method: "POST",
    headers: cookie ? { Cookie: cookie } : {},
    body: form,
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown>;
  return { status: res.status, json };
}

async function main() {
  try {
    await startApi();

    // --- auth guard ---
    const unauth = await upload("resume.pdf", VALID_PDF);
    check("unauthenticated upload -> 401", unauth.status === 401, `status=${unauth.status}`);

    const reg = await apiCall<{ user?: { email?: string } }>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ name: "JD Upload Tester", email: EMAIL, password: "password123" }),
    });
    check("register -> 201 + cookie", reg.status === 201 && cookie.startsWith("sid="), `status=${reg.status}`);
    check("register returns sanitized user", reg.json.user?.email === EMAIL);

    // --- happy paths ---
    const pdf = await upload("resume.pdf", VALID_PDF);
    check(
      "valid PDF -> 200 + text incl. fixtures",
      pdf.status === 200 && typeof (pdf.json as { text?: unknown }).text === "string" && (pdf.json as { text: string }).text.includes("prepWithJD"),
      `status=${pdf.status}`,
    );
    check("extract response is { text } only", pdf.status === 200 && Object.keys(pdf.json).join(",") === "text", Object.keys(pdf.json).join(","));

    const docx = await upload("resume.docx", LONG_DOCX);
    const docxText = (docx.json as { text?: string }).text ?? "";
    check(
      "valid DOCX -> 200 + text incl. fixtures",
      docx.status === 200 && docxText.length >= MIN_TEXT_CHARS && docxText.includes("Paragraph two"),
      `status=${docx.status} len=${docxText.length}`,
    );
    check("normalize collapses 3+ newlines to 2", docx.status === 200 && !/\n{3,}/.test(docxText), JSON.stringify(docxText));

    // --- rejection by magic bytes ---
    const exe = await upload("resume.pdf", FAKE_EXE);
    check("renamed .exe (PDF name, MZ bytes) -> 400 UNSUPPORTED_FILE_TYPE", exe.status === 400 && exe.json.error === "UNSUPPORTED_FILE_TYPE", `status=${exe.status} error=${String(exe.json.error)}`);

    const txtExt = await upload("notes.txt", VALID_PDF);
    check("PDF bytes with .txt extension -> 400 UNSUPPORTED_FILE_TYPE", txtExt.status === 400 && txtExt.json.error === "UNSUPPORTED_FILE_TYPE", `status=${txtExt.status} error=${String(txtExt.json.error)}`);

    const reExt = await upload("resume.docx", VALID_PDF);
    check("PDF bytes mislabeled .docx -> 400 UNSUPPORTED_FILE_TYPE", reExt.status === 400 && reExt.json.error === "UNSUPPORTED_FILE_TYPE", `status=${reExt.status} error=${String(reExt.json.error)}`);

    // --- empty / scanned-like ---
    const empty = await upload("empty.pdf", EMPTY_PDF);
    check(
      "empty PDF (no text layer) -> 422 NO_TEXT_FOUND",
      empty.status === 422 && empty.json.error === "NO_TEXT_FOUND" && empty.json.message === "No readable text found. If this is a scanned PDF, paste the text manually.",
      `status=${empty.status} error=${String(empty.json.error)} msg=${String(empty.json.message)}`,
    );
    const short = await upload("short.docx", SHORT_DOCX);
    check("under-50-char DOCX -> 422 NO_TEXT_FOUND", short.status === 422 && short.json.error === "NO_TEXT_FOUND", `status=${short.status} error=${String(short.json.error)}`);

    // --- corrupt / password-protected ---
    const corrupt = await upload("corrupt.pdf", CORRUPT_PDF);
    check("corrupt PDF (valid magic, bad body) -> 422 UNREADABLE_FILE", corrupt.status === 422 && corrupt.json.error === "UNREADABLE_FILE", `status=${corrupt.status} error=${String(corrupt.json.error)}`);
    const encrypted = await upload("encrypted.pdf", ENCRYPTED_PDF);
    check("password-protected PDF -> 422 UNREADABLE_FILE", encrypted.status === 422 && encrypted.json.error === "UNREADABLE_FILE", `status=${encrypted.status} error=${String(encrypted.json.error)}`);

    // --- oversized ---
    const big = await upload("big.pdf", OVER_SIZED);
    check(">5 MB upload -> 413 FILE_TOO_LARGE", big.status === 413 && big.json.error === "FILE_TOO_LARGE", `status=${big.status} error=${String(big.json.error)}`);

    // --- extract must not create anything ---
    const kits = await apiCall<{ kits: unknown[] }>("/api/kits");
    check("extraction created no kits", kits.status === 200 && Array.isArray(kits.json.kits) && kits.json.kits.length === 0, `count=${(kits.json.kits as unknown[]).length}`);
  } catch (err) {
    check("verify-upload run did not crash", false, err instanceof Error ? err.message : String(err));
  } finally {
    try {
      await connectDb(process.env.MONGODB_URI);
      const users = await models.UserModel.find({ email: EMAIL });
      const ids = users.map((u) => u._id);
      for (const id of ids) {
        await models.KitModel.deleteMany({ userId: id });
        await models.SessionModel.deleteMany({ userId: id });
      }
      await models.UserModel.deleteMany({ _id: { $in: ids } });
      await disconnectDb();
      console.log(`cleaned up ${ids.length} temp user(s)`);
    } catch (err) {
      console.error("cleanup failed:", err instanceof Error ? err.message : err);
    }
    killTree(api);
  }

  console.log("\n=== verify-upload results ===");
  for (const r of results) console.log(r);
  const failed = results.filter((r) => r.startsWith("FAIL")).length;
  console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();