/**
 * Day-1 end-to-end check against a REAL MongoDB:
 *   register -> login -> bad-login 401 -> unauth 401 -> create kit -> list ->
 *   run retrieval (crawls the local fixture site) -> persisted pages_used ->
 *   logout -> session revoked -> login again.
 *
 * Spawns the fixture site + the Express API itself, so nothing needs to be running.
 * Run: npm run e2e   (requires MONGODB_URI set in apps/api/.env)
 */
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_PORT = 8765;
const API_PORT = 4100;
const FIXTURE_URL = `http://127.0.0.1:${FIXTURE_PORT}`;
const API = `http://127.0.0.1:${API_PORT}`;
const EMAIL = `e2e-${Date.now()}@test.local`;

let fixture: ChildProcess | null = null;
let api: ChildProcess | null = null;
let cookie = "";

const results: string[] = [];
const check = (label: string, pass: boolean, detail = "") => {
  results.push(`${pass ? "PASS" : "FAIL"} — ${label}${detail ? ` (${detail})` : ""}`);
};

function startFixture(): Promise<void> {
  return new Promise((resolveP, reject) => {
    fixture = spawn(process.execPath, [join(ROOT, "tooling/fixture-site/server.mjs")], {
      env: { ...process.env, FIXTURE_PORT: String(FIXTURE_PORT) },
      stdio: ["ignore", "pipe", "ignore"],
    });
    fixture.stdout?.on("data", (d) => d.toString().includes("[fixture]") && resolveP());
    fixture.on("error", reject);
    fixture.on("exit", (code) => code !== 0 && reject(new Error("fixture exited early")));
    setTimeout(() => reject(new Error("fixture didn't start")), 8000);
  });
}

function startApi(): Promise<void> {
  return new Promise((resolveP, reject) => {
    api = spawn("npx", ["tsx", "apps/api/src/index.ts"], {
      cwd: ROOT,
      env: { ...process.env, API_PORT: String(API_PORT), FIXTURE_PORT: String(FIXTURE_PORT) },
      stdio: ["ignore", "pipe", "ignore"],
    });
    api.stdout?.on("data", (d) => d.toString().includes("[api] listening") && resolveP());
    api.on("error", reject);
    const killer = setTimeout(() => {
      if (api && !api.killed) api.kill("SIGKILL");
      reject(new Error("API didn't start"));
    }, 40_000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (api as any).__killer = killer;
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
  const cleared = set.find((c) => c.startsWith("sid=;")); // emptied cookie
  if (cleared && !set.some((c) => !c.startsWith("sid=;") && c.startsWith("sid="))) cookie = "";
  const json = (await res.json().catch(() => null)) as T;
  return { status: res.status, json };
}

async function main() {
  await startFixture();
  await startApi();

  try {
    // --- unauth guard ---
    const unauth = await apiCall<{ error: string }>("/api/kits");
    check("unauthenticated /api/kits -> 401", unauth.status === 401, `status=${unauth.status}`);

    // --- register ---
    const reg = await apiCall("/api/auth/register", { method: "POST", body: JSON.stringify({ name: "E2E Tester", email: EMAIL, password: "password123" }) });
    check("register -> 201 + sets cookie", reg.status === 201 && cookie.startsWith("sid="), `status=${reg.status}`);
    const regUser = reg.json as { user?: { email?: string } };
    check("register returns sanitized user (no hash)", reg.status === 201 && regUser.user?.email === EMAIL);

    // --- me ---
    const me = await apiCall<{ user: { email: string } }>("/api/auth/me");
    check("GET /me with cookie -> 200", me.status === 200 && me.json.user.email === EMAIL);

    // --- login bad password ---
    const bad = await apiCall("/api/auth/login", { method: "POST", body: JSON.stringify({ email: EMAIL, password: "wrong-password" }) });
    check("login wrong password -> 401 BAD_CREDENTIALS", bad.status === 401 && (bad.json as { error: string }).error === "BAD_CREDENTIALS");

    // --- validation ---
    const empty = await apiCall<{ error: string }>("/api/kits", { method: "POST", body: JSON.stringify({}) });
    check("create kit with empty body -> 400 VALIDATION", empty.status === 400 && empty.json.error === "VALIDATION");

    // --- create kit ---
    const create = await apiCall("/api/kits", {
      method: "POST",
      body: JSON.stringify({ jd: "Senior Backend Engineer. 5+ years with Node and TypeScript. Distributed systems experience. Good communication.", company_url: FIXTURE_URL, days: 5 }),
    });
    check("create kit -> 201 draft", create.status === 201 && (create.json as { kit: { status: string } }).kit.status === "draft");
    const kitId = (create.json as { kit: { _id: string } }).kit._id;

    // --- list contains it ---
    const list = await apiCall<{ kits: Array<{ _id: string; status: string }> }>("/api/kits");
    check("list includes new kit", list.status === 200 && list.json.kits.some((k) => k._id === kitId));

    // --- retrieval ---
    const retrieve = await apiCall<{ kit: { status: string }; retrieval: { pages_used: string[]; failures: Array<{ code: string }> } }>(
      `/api/kits/${kitId}/retrieve`,
      { method: "POST" },
    );
    check("retrieve -> status retrieved", retrieve.status === 200 && retrieve.json.kit.status === "retrieved");
    check(
      "retrieval crawled careers + interview-process (relative links)",
      retrieve.json.retrieval.pages_used.includes(`${FIXTURE_URL}/careers`) &&
        retrieve.json.retrieval.pages_used.includes(`${FIXTURE_URL}/careers/interview-process`),
      retrieve.json.retrieval.pages_used.length ? `pages=${retrieve.json.retrieval.pages_used.length}` : "no pages",
    );
    check(
      "robots-disallowed /private absent",
      !retrieve.json.retrieval.pages_used.includes(`${FIXTURE_URL}/private`),
    );
    check(
      "search recorded as failure (no API key) not crash",
      retrieve.json.retrieval.failures.some((f) => f.code === "SEARCH_API_KEY_MISSING"),
    );

    // --- persisted model ---
    const detail = await apiCall<{ kit: { status: string; content: { source: { pages_used: string[]; company: string } } } }>(`/api/kits/${kitId}`);
    check(
      "persisted content.source.pages_used matches retrieval + status retrieved",
      detail.status === 200 && detail.json.kit.status === "retrieved" && detail.json.kit.content.source.pages_used.length === retrieve.json.retrieval.pages_used.length,
    );
    check("source.company derived from URL host", detail.json.kit.content.source.company !== "");

    // --- logout revokes session ---
    const logout = await apiCall<{ ok: boolean }>("/api/auth/logout", { method: "POST" });
    check("logout -> ok", logout.status === 200 && logout.json.ok === true);
    const after = await apiCall<{ error: string }>("/api/auth/me");
    check("me after logout -> 401 (session revoked)", after.status === 401);

    // --- login again ---
    const again = await apiCall("/api/auth/login", { method: "POST", body: JSON.stringify({ email: EMAIL, password: "password123" }) });
    check("login again -> 200 + fresh cookie", again.status === 200 && cookie.startsWith("sid="));

    // --- cleanup our test kit ---
    const del = await apiCall<{ ok: boolean }>(`/api/kits/${kitId}`, { method: "DELETE" });
    check("delete test kit", del.status === 200 && del.json.ok === true);
  } catch (err) {
    check("e2e run did not crash", false, err instanceof Error ? err.message : String(err));
  } finally {
    fixture?.kill();
    api?.kill();
  }

  console.log("\n=== e2e results ===");
  for (const r of results) console.log(r);
  const failed = results.filter((r) => r.startsWith("FAIL")).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("e2e crashed:", err);
  process.exit(1);
});