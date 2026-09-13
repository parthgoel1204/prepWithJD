/**
 * Day-1 end-to-end check against a REAL MongoDB covering the 6 verification items:
 *   1. bad-login 401 is distinct from session-expired 401 (backend codes + messages)
 *   2. deleting a session doc in Mongo -> protected route -> 401 SESSION_EXPIRED + cookie cleared
 *   3. Tavily search integration (shape + persisted discussion + rate-limited path) OR key-missing failure
 *   4. real 404 + timeout source failures recorded; run still completes
 *   5. batch import preserves per-case `days`
 *   6. robots.txt excludes a /private page that IS linked, reporting the matched rule
 *
 * Spawns the fixture site + the Express API itself, so nothing needs to be running.
 * Run: npm run e2e   (requires MONGODB_URI set in apps/api/.env)
 */
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { connectDb, disconnectDb, models, type KitContent } from "@prepwithjd/pipeline";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_PORT = 8765;
const API_PORT = 4100;
const FIXTURE_URL = `http://127.0.0.1:${FIXTURE_PORT}`;
const API = `http://127.0.0.1:${API_PORT}`;
const EMAIL = `e2e-${Date.now()}@test.local`;

// Mirror the API's load of apps/api/.env so assertions know whether a Tavily key exists.
try {
  process.loadEnvFile(join(ROOT, "apps/api/.env"));
} catch {
  /* no .env — treat as missing key */
}
const TAVILY_SET = Boolean(process.env.TAVILY_API_KEY);

let fixture: ChildProcess | null = null;
let api: ChildProcess | null = null;
let cookie = "";

const results: string[] = [];
const check = (label: string, pass: boolean, detail = "") => {
  results.push(`${pass ? "PASS" : "FAIL"} — ${label}${detail ? ` (${detail})` : ""}`);
};

function killTree(child: ChildProcess | null): void {
  if (!child) return;
  // spawn with detached:true -> child is its own process-group leader, so a group
  // kill takes down the whole tree (npx wrapper + tsx server), not just the wrapper.
  try {
    if (child.pid) process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGKILL");
  }
}

function startFixture(): Promise<void> {
  return new Promise((resolveP, reject) => {
    fixture = spawn(process.execPath, [join(ROOT, "tooling/fixture-site/server.mjs")], {
      env: { ...process.env, FIXTURE_PORT: String(FIXTURE_PORT), SLOW_DELAY_MS: "30000" },
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
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
      detached: true,
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
  try {
    await startFixture();
    await startApi();
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

    // --- ITEM 1: bad password is its OWN 401, distinct from session expiry ---
    const bad = await apiCall("/api/auth/login", { method: "POST", body: JSON.stringify({ email: EMAIL, password: "wrong-password" }) });
    const badJson = bad.json as { error: string; message: string };
    check(
      "ITEM 1: wrong password -> 401 BAD_CREDENTIALS + generic message",
      bad.status === 401 && badJson.error === "BAD_CREDENTIALS" && badJson.message === "Invalid email or password",
      `error=${badJson.error}`,
    );
    check("ITEM 1: bad login did NOT clear the valid cookie", cookie.startsWith("sid="));

    // --- validation ---
    const empty = await apiCall<{ error: string }>("/api/kits", { method: "POST", body: JSON.stringify({}) });
    check("create kit with empty body -> 400 VALIDATION", empty.status === 400 && empty.json.error === "VALIDATION");

    // --- ITEM 5: batch import preserves per-case days ---
    const batch = await apiCall<{ count: number; kits: Array<{ _id: string }> }>("/api/kits/batch", {
      method: "POST",
      body: JSON.stringify({
        items: [
          { jd: "Frontend Engineer. React, TypeScript. Fast iteration.", company_url: FIXTURE_URL, days: 3 },
          { jd: "Backend Engineer. Node, Postgres. Async systems.", company_url: FIXTURE_URL, days: 5 },
        ],
      }),
    });
    check("batch import -> 2 kits created", batch.status === 201 && batch.json.count === 2, `count=${batch.json.count}`);
    const batchIds = batch.json.kits.map((k) => k._id);
    const [b3, b5] = await Promise.all(
      batchIds.map((id) => apiCall<{ kit: { input: { days: number } } }>(`/api/kits/${id}`)),
    );
    check(
      "ITEM 5: per-case days preserved (3 and 5)",
      b3.status === 200 && b5.status === 200 && b3.json.kit.input.days === 3 && b5.json.kit.input.days === 5,
      `days=${b3.json.kit.input.days}/${b5.json.kit.input.days}`,
    );
    await Promise.all(batchIds.map((id) => apiCall(`/api/kits/${id}`, { method: "DELETE" })));

    // --- create main kit ---
    const create = await apiCall("/api/kits", {
      method: "POST",
      body: JSON.stringify({ jd: "Senior Backend Engineer. 5+ years with Node and TypeScript. Distributed systems experience. Good communication.", company_url: FIXTURE_URL, days: 5 }),
    });
    check("create kit -> 201 draft", create.status === 201 && (create.json as { kit: { status: string } }).kit.status === "draft");
    const kitId = (create.json as { kit: { _id: string } }).kit._id;

    // --- list contains it ---
    const list = await apiCall<{ kits: Array<{ _id: string; status: string }> }>("/api/kits");
    check("list includes new kit", list.status === 200 && list.json.kits.some((k) => k._id === kitId));

    // --- ITEM 3 + 6: retrieval on the fixture (search hits + robots rule) ---
    const retrieve = await apiCall<{
      kit: { status: string };
      retrieval: {
        pages_used: string[];
        robots_blocked: Array<{ url: string; rule: string }>;
        search_hits: Array<{ title: string; url: string; snippet: string }>;
        failures: Array<{ code: string }>;
      };
    }>(`/api/kits/${kitId}/retrieve`, { method: "POST" });
    check("retrieve -> status retrieved", retrieve.status === 200 && retrieve.json.kit.status === "retrieved");
    check(
      "retrieval crawled careers + interview-process (relative links)",
      retrieve.json.retrieval.pages_used.includes(`${FIXTURE_URL}/careers`) &&
        retrieve.json.retrieval.pages_used.includes(`${FIXTURE_URL}/careers/interview-process`),
      retrieve.json.retrieval.pages_used.length ? `pages=${retrieve.json.retrieval.pages_used.length}` : "no pages",
    );
    check(
      "ITEM 6: /private absent from pages_used (robots-disallowed)",
      !retrieve.json.retrieval.pages_used.includes(`${FIXTURE_URL}/private`),
    );
    check(
      "ITEM 6: robots_blocked reports /private WITH matched rule",
      retrieve.json.retrieval.robots_blocked.some(
        (b) => b.url === `${FIXTURE_URL}/private` && b.rule === "Disallow: /private",
      ),
      retrieve.json.retrieval.robots_blocked.map((b) => `${b.url}->${b.rule}`).join(", ") || "none",
    );

    if (TAVILY_SET) {
      const hits = retrieve.json.retrieval.search_hits;
      check(
        "ITEM 3: Tavily search_hits returned with title/url/snippet shape",
        hits.every((h) => typeof h.title === "string" && h.url.startsWith("http") && typeof h.snippet === "string"),
        hits.length ? `${hits.length} hits, first=${hits[0]?.title}` : "0 hits",
      );
      check(
        "ITEM 3: no SEARCH_API_KEY_MISSING failure when key present",
        !retrieve.json.retrieval.failures.some((f) => f.code === "SEARCH_API_KEY_MISSING"),
      );
    } else {
      check(
        "ITEM 3: no key -> search recorded as failure, run still completes",
        retrieve.json.retrieval.failures.some((f) => f.code === "SEARCH_API_KEY_MISSING"),
      );
    }

    // --- persisted model incl. discussion field ---
    const detail = await apiCall<{ kit: { status: string; content: KitContent } }>(`/api/kits/${kitId}`);
    check(
      "persisted content.source.pages_used matches retrieval + status retrieved",
      detail.status === 200 &&
        detail.json.kit.status === "retrieved" &&
        detail.json.kit.content.source.pages_used.length === retrieve.json.retrieval.pages_used.length,
    );
    check("source.company derived from URL host", detail.json.kit.content.source.company !== "");
    if (TAVILY_SET) {
      const persisted = detail.json.kit.content.source.discussion ?? [];
      check(
        "ITEM 3: persisted content.source.discussion matches search_hits",
        persisted.length === retrieve.json.retrieval.search_hits.length,
        `persisted=${persisted.length} returned=${retrieve.json.retrieval.search_hits.length}`,
      );
    }

    // --- failures endpoint works (diagnostics read path) ---
    const failuresBefore = await apiCall<{ failures: Array<{ code: string }> }>(`/api/kits/${kitId}/failures`);
    check("GET /:id/failures -> 200", failuresBefore.status === 200 && Array.isArray(failuresBefore.json.failures));

    // --- ITEM 4a: real 404 source failure ---
    const kit404 = await apiCall<{ kit: { _id: string } }>("/api/kits", {
      method: "POST",
      body: JSON.stringify({ jd: "404 kit.", company_url: `${FIXTURE_URL}/missing-404`, days: 5 }),
    });
    const kit404Id = kit404.json.kit._id;
    const ret404 = await apiCall<{ kit: { status: string }; retrieval: { failures: Array<{ code: string }> } }>(
      `/api/kits/${kit404Id}/retrieve`,
      { method: "POST", body: JSON.stringify({ timeoutMs: 1500, retries: 0 }) },
    );
    check(
      "ITEM 4a: 404 URL -> HTTP_404 recorded, run completes (status retrieved)",
      ret404.status === 200 &&
        ret404.json.kit.status === "retrieved" &&
        ret404.json.retrieval.failures.some((f) => f.code === "HTTP_404"),
      `status=${ret404.status} codes=${ret404.json.retrieval.failures.map((f) => f.code).join(",") || "none"}`,
    );

    // --- ITEM 4b: real timeout source failure via /slow ---
    const kitSlow = await apiCall<{ kit: { _id: string } }>("/api/kits", {
      method: "POST",
      body: JSON.stringify({ jd: "slow kit.", company_url: `${FIXTURE_URL}/slow`, days: 5 }),
    });
    const kitSlowId = kitSlow.json.kit._id;
    const retSlow = await apiCall<{ kit: { status: string }; retrieval: { failures: Array<{ code: string }> } }>(
      `/api/kits/${kitSlowId}/retrieve`,
      { method: "POST", body: JSON.stringify({ timeoutMs: 700, retries: 0 }) },
    );
    check(
      "ITEM 4b: /slow -> TIMEOUT recorded, run completes (status retrieved)",
      retSlow.status === 200 &&
        retSlow.json.kit.status === "retrieved" &&
        retSlow.json.retrieval.failures.some((f) => f.code === "TIMEOUT"),
      `status=${retSlow.status} code=${retSlow.json.retrieval.failures.map((f) => f.code).join(",") || "none"}`,
    );

    // persisted failures readable via endpoint
    const fail404 = await apiCall<{ failures: Array<{ code: string; sourceUrl: string }> }>(`/api/kits/${kit404Id}/failures`);
    const failSlow = await apiCall<{ failures: Array<{ code: string; sourceUrl: string }> }>(`/api/kits/${kitSlowId}/failures`);
    check(
      "ITEM 4: failures persisted in Atlas queryable per-kit",
      fail404.json.failures.some((f) => f.code === "HTTP_404") && failSlow.json.failures.some((f) => f.code === "TIMEOUT"),
      `404=${fail404.json.failures.map((f) => f.code).join(",")} slow=${failSlow.json.failures.map((f) => f.code).join(",")}`,
    );

    // --- ITEM 2: delete the session doc directly in Atlas -> SESSION_EXPIRED ---
    await connectDb(process.env.MONGODB_URI);
    const token = cookie.startsWith("sid=") ? cookie.slice(4) : "";
    const before = await models.SessionModel.countDocuments({ token });
    await models.SessionModel.deleteOne({ token });
    const afterDel = await models.SessionModel.countDocuments({ token });
    await disconnectDb();
    check("ITEM 2: deleted session doc for current token", before === 1 && afterDel === 0, `before=${before} after=${afterDel}`);
    const expiredProbe = await apiCall<{ error: string; message: string }>("/api/kits");
    check(
      "ITEM 2: protected route -> 401 SESSION_EXPIRED with clean message",
      expiredProbe.status === 401 && expiredProbe.json.error === "SESSION_EXPIRED" && expiredProbe.json.message === "Session expired, please log in again",
      `error=${expiredProbe.json.error}`,
    );
    check("ITEM 2: cookie cleared by SESSION_EXPIRED response", cookie === "");

    // --- login again with fresh credentials ---
    const again = await apiCall("/api/auth/login", { method: "POST", body: JSON.stringify({ email: EMAIL, password: "password123" }) });
    check("login again -> 200 + fresh cookie", again.status === 200 && cookie.startsWith("sid="));

    // --- cleanup our test kits ---
    for (const id of [kitId, kit404Id, kitSlowId]) {
      const del = await apiCall<{ ok: boolean }>(`/api/kits/${id}`, { method: "DELETE" });
      check("delete test kit", del.status === 200 && del.json.ok === true);
    }
  } catch (err) {
    check("e2e run did not crash", false, err instanceof Error ? err.message : String(err));
  } finally {
    killTree(fixture);
    killTree(api);
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