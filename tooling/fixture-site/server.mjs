/**
 * Minimal zero-dependency static-file server used to test the crawler against a
 * locally-served, non-hardcoded host (robots.txt + relative-link site).
 *
 * `node tooling/fixture-site/server.mjs`      -> serves ./public on :9999
 * `FIXTURE_PORT=9000 node ...`                -> override port
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("./public", import.meta.url));
const PORT = Number(process.env.FIXTURE_PORT ?? 9999);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    let path = decodeURIComponent(url.pathname);
    if (path === "/") path = "/index.html";
    else if (!extname(path)) path += ".html";

    const file = join(ROOT, path);
    if (!file.startsWith(ROOT)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("forbidden");
      return;
    }

    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
      "Content-Length": body.length,
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  }
});

server.on("error", (err) => {
  console.error(`[fixture] failed to bind :${PORT} — ${err.message}`);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[fixture] serving ${ROOT} on http://localhost:${PORT}`);
});