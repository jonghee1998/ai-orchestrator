import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import Module from "node:module";
import { ArchitectureFormatError, approvePlan, createIdea, GitHubError, readArchitecture, readRepo } from "./github";
import { parsePlan, planHash, type PlanComment, type PlanIssue } from "./plans";
import { ARCH_MAX_BYTES, SELF_REPO, mergedSwitches } from "./model";
import { cookieName, csrfToken, issueSession } from "../session/session";

const REPO = "o/r";
const ENV = { ORCH_GITHUB_TOKEN: "test-write-token-value" };
const plan = { goal: "목표", steps: [{ id: 1, title: "t1", task: "x", done_when: ["npm test 통과"] }] };
const body = (p: unknown = plan) => "설명\n\n```json\n" + JSON.stringify(p) + "\n```";
const H = planHash((parsePlan(body()) as { ok: true; plan: Parameters<typeof planHash>[0] }).plan);
const issue = (extra: Partial<PlanIssue> = {}): PlanIssue => ({
  number: 7, title: "[plan] 계획", body: body(), html_url: `https://github.com/${REPO}/issues/7`, state: "open", labels: [], user: { login: "o" }, ...extra,
});

type Call = { method: string; path: string; body: unknown };
/** Fake GitHub: serves the Issue + comments, records every request. */
type FakeOpts = { labelStatus?: number; issueStatus?: number; saveFail?: Record<string, number>; wakeFail?: string[]; architecture?: Record<string, { status: number; body?: unknown }> };
function fakeGitHub(i: PlanIssue, comments: PlanComment[] = [], opts: FakeOpts = {}) {
  const calls: Call[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    calls.push({ method, path: u.pathname + u.search, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const json = (status: number, j: unknown) => new Response(JSON.stringify(j), { status, headers: { "content-type": "application/json" } });
    if (method === "GET" && u.pathname === `/repos/${REPO}/issues/${i.number}`) return json(200, i);
    if (method === "GET" && u.pathname === `/repos/${REPO}/issues/${i.number}/comments`) return json(200, comments);
    if (method === "POST" && u.pathname === `/repos/${REPO}/issues/${i.number}/labels`) return json(opts.labelStatus ?? 200, [{ name: "orch:go" }]);
    if (method === "POST" && u.pathname === `/repos/${REPO}/issues`) return json(opts.issueStatus ?? 201, { number: 42, html_url: `https://github.com/${REPO}/issues/42` });
    // Switch writes for any repo: PATCH variable (saveFail[repo] = status) then orchestrator.yml dispatch (wakeFail).
    const sw = /^\/repos\/([^/]+\/[^/]+)\/actions\/(variables\/ORCH_[A-Z]+|workflows\/orchestrator\.yml\/dispatches)$/.exec(u.pathname);
    if (sw && method === "PATCH") return opts.saveFail?.[sw[1]] ? json(opts.saveFail[sw[1]], { message: "no" }) : new Response(null, { status: 204 });
    if (sw && method === "POST") return opts.wakeFail?.includes(sw[1]) ? json(500, { message: "no" }) : new Response(null, { status: 204 });
    // docs/architecture.json per repo (architecture[repo] = { status, body }); missing → 404.
    const arch = /^\/repos\/([^/]+\/[^/]+)\/contents\/docs\/architecture\.json$/.exec(u.pathname);
    if (arch && method === "GET" && opts.architecture?.[arch[1]]) return json(opts.architecture[arch[1]].status, opts.architecture[arch[1]].body ?? { message: "x" });
    return json(404, { message: "Not Found" });
  }) as typeof fetch;
  const labelPosts = () => calls.filter((c) => c.method === "POST" && c.path.endsWith("/labels"));
  const writes = () => calls.filter((c) => c.method !== "GET");
  return { f, calls, labelPosts, writes };
}

test("approvePlan: a pending plan with the same hash gets exactly one orch:go label POST", async () => {
  const g = fakeGitHub(issue());
  assert.deepEqual(await approvePlan(REPO, 7, H, ENV, g.f), { ok: true, issue: 7 });
  assert.deepEqual(g.labelPosts(), [{ method: "POST", path: `/repos/${REPO}/issues/7/labels`, body: { labels: ["orch:go"] } }]);
  assert.equal(g.writes().length, 1, "no other writes");
});

test("approvePlan: an Issue already running (orch:run) is not_pending and gets no label", async () => {
  for (const l of ["orch:run", "orch:go", "orch:done"]) {
    const g = fakeGitHub(issue({ labels: [{ name: l }] }));
    assert.deepEqual(await approvePlan(REPO, 7, H, ENV, g.f), { ok: false, error: "not_pending" }, l);
    assert.equal(g.writes().length, 0, l);
  }
});

test("approvePlan: non-owner author, closed, non-[plan] or broken plan → not_pending, no label", async () => {
  for (const extra of [{ user: { login: "someone" } }, { user: null }, { state: "closed" }, { title: "계획" }, { body: "계획 없음" }, { pull_request: {} }] as Partial<PlanIssue>[]) {
    const g = fakeGitHub(issue(extra));
    assert.deepEqual(await approvePlan(REPO, 7, H, ENV, g.f), { ok: false, error: "not_pending" }, JSON.stringify(extra));
    assert.equal(g.writes().length, 0);
  }
});

test("approvePlan: the plan changed after the screen was opened → plan_changed, no label", async () => {
  const g = fakeGitHub(issue({ body: body({ ...plan, goal: "바뀐 목표" }) }));
  assert.deepEqual(await approvePlan(REPO, 7, H, ENV, g.f), { ok: false, error: "plan_changed" });
  assert.equal(g.writes().length, 0);
});

test("approvePlan: no write token → GitHubError 503 and no GitHub request; label failure → GitHubError", async () => {
  const g = fakeGitHub(issue());
  await assert.rejects(approvePlan(REPO, 7, H, { GITHUB_TOKEN: "read-only-test-token" }, g.f), (e) => e instanceof GitHubError && e.status === 503);
  assert.equal(g.calls.length, 0);
  const bad = fakeGitHub(issue(), [], { labelStatus: 403 });
  await assert.rejects(approvePlan(REPO, 7, H, ENV, bad.f), (e) => e instanceof GitHubError && e.status === 403);
});

// ---------------------------------------------------------------- createIdea

test("createIdea: trims the title and POSTs exactly one '[idea] ' Issue", async () => {
  const g = fakeGitHub(issue());
  assert.deepEqual(await createIdea(REPO, "  상황판 채팅  ", "폰에서 바로\n물어보고 싶음", ENV, g.f), { ok: true, issue: 42, url: `https://github.com/${REPO}/issues/42` });
  assert.deepEqual(g.calls, [{ method: "POST", path: `/repos/${REPO}/issues`, body: { title: "[idea] 상황판 채팅", body: "폰에서 바로\n물어보고 싶음" } }]);
  const empty = fakeGitHub(issue());
  assert.equal((await createIdea(REPO, "x".repeat(80), undefined, ENV, empty.f)).ok, true, "80 chars and no body are fine");
  assert.deepEqual(empty.calls[0].body, { title: `[idea] ${"x".repeat(80)}`, body: "" });
  const full = fakeGitHub(issue());
  assert.equal((await createIdea(REPO, "t", "가".repeat(4000), ENV, full.f)).ok, true, "4000-char body");
});

test("createIdea: bad title/body → error with no GitHub request", async () => {
  for (const t of ["", "   ", "x".repeat(81), "두 줄\n제목", "캐리지\r리턴", 5, null, undefined]) {
    const g = fakeGitHub(issue());
    assert.deepEqual(await createIdea(REPO, t, "", ENV, g.f), { ok: false, error: "bad_title" }, JSON.stringify(t));
    assert.equal(g.calls.length, 0);
  }
  for (const b of ["가".repeat(4001), 7, { x: 1 }]) {
    const g = fakeGitHub(issue());
    assert.deepEqual(await createIdea(REPO, "제목", b, ENV, g.f), { ok: false, error: "bad_body" });
    assert.equal(g.calls.length, 0);
  }
});

test("createIdea: no write token → GitHubError 503 and no request; GitHub failure → GitHubError", async () => {
  const g = fakeGitHub(issue());
  await assert.rejects(createIdea(REPO, "제목", "", { GITHUB_TOKEN: "read-only-test-token" }, g.f), (e) => e instanceof GitHubError && e.status === 503);
  await assert.rejects(createIdea(REPO, "제목", "", {}, g.f), (e) => e instanceof GitHubError && e.status === 503);
  assert.equal(g.calls.length, 0);
  const bad = fakeGitHub(issue(), [], { issueStatus: 403 });
  await assert.rejects(createIdea(REPO, "제목", "", ENV, bad.f), (e) => e instanceof GitHubError && e.status === 403);
  assert.equal(bad.calls.length, 1, "no retry");
});

// ---------------------------------------------------------------- route.ts POST (auth + validation before any GitHub call)

// Compiled route.ts keeps the '@/...' alias; map it onto the test build root (.test-build/).
const buildRoot = path.resolve(__dirname, "../..");
type Resolve = (request: string, ...rest: unknown[]) => string;
const M = Module as unknown as { _resolveFilename: Resolve };
const origResolve = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return origResolve.call(this, request.startsWith("@/") ? path.join(buildRoot, request.slice(2)) : request, ...rest);
};

const ADMIN = "test-admin-token-for-route";
async function withRoute(env: Record<string, string | undefined>, i: PlanIssue, run: (post: (b: unknown, h?: Record<string, string>) => Promise<Response>, g: ReturnType<typeof fakeGitHub>) => Promise<void>, opts: FakeOpts = {}) {
  const keys = ["ORCH_REPOS", "GITHUB_REPO", "ORCH_GITHUB_TOKEN", "GITHUB_READ_TOKEN", "GITHUB_TOKEN", "CONTROL_ADMIN_TOKEN", "CONTROL_READ_TOKEN", "ORCH_SELF_REPO"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const savedFetch = globalThis.fetch;
  const g = fakeGitHub(i, [], opts);
  try {
    for (const k of keys) delete process.env[k];
    for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
    globalThis.fetch = g.f;
    const { POST } = await import("../../app/api/orch/route");
    const post = (b: unknown, h: Record<string, string> = {}) =>
      POST(new Request("http://localhost/api/orch", { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(b) }));
    await run(post, g);
  } finally {
    globalThis.fetch = savedFetch;
    for (const k of keys) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
}
const LIVE = { ORCH_REPOS: REPO, ORCH_GITHUB_TOKEN: ENV.ORCH_GITHUB_TOKEN, CONTROL_ADMIN_TOKEN: ADMIN };
const approve = { action: "approve", repo: REPO, issue: 7, hash: H };

test("route POST approve: without a session or admin token → 401/403 and zero GitHub calls", async () => {
  await withRoute(LIVE, issue(), async (post, g) => {
    assert.equal((await post(approve)).status, 401);
    assert.equal((await post(approve, { "x-admin-token": "wrong-token-but-long-enough" })).status, 401);
    assert.equal((await post(approve, { cookie: "orch_session=forged" })).status, 401);
    assert.equal(g.calls.length, 0);
  });
});

test("route POST approve: validates repo/issue/hash (400), token (503), then approves or returns 409", async () => {
  const h = { "x-admin-token": ADMIN };
  await withRoute(LIVE, issue(), async (post, g) => {
    for (const b of [{ ...approve, repo: "x/y" }, { ...approve, issue: 0 }, { ...approve, issue: 1.5 }, { ...approve, issue: "7" }, { ...approve, hash: "abc" }, { ...approve, hash: "g123456789abcdef" }, { ...approve, hash: H + "0" }]) {
      assert.equal((await post(b, h)).status, 400, JSON.stringify(b));
    }
    assert.equal(g.calls.length, 0, "bad input never reaches GitHub");
    const ok = await post(approve, h);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, issue: 7 });
    assert.equal(g.labelPosts().length, 1);
    const changed = await post({ ...approve, hash: "0123456789abcdef" }, h);
    assert.equal(changed.status, 409);
    assert.equal((await changed.json()).error, "plan_changed");
    assert.equal(g.labelPosts().length, 1, "no second label POST");
  });
  await withRoute(LIVE, issue({ labels: [{ name: "orch:run" }] }), async (post, g) => {
    const r = await post(approve, h);
    assert.deepEqual([r.status, (await r.json()).error], [409, "not_pending"]);
    assert.equal(g.writes().length, 0);
  });
  await withRoute({ ...LIVE, ORCH_GITHUB_TOKEN: undefined, GITHUB_TOKEN: "read-only-test-token" }, issue(), async (post, g) => {
    const r = await post(approve, h);
    assert.deepEqual([r.status, (await r.json()).error], [503, "write_unconfigured"]);
    assert.equal(g.calls.length, 0);
  });
  await withRoute(LIVE, issue({ number: 8 }), async (post) => {
    const r = await post(approve, h); // Issue 7 → fake 404
    assert.equal(r.status, 502);
    assert.equal((await r.json()).error, "github_error");
  });
});

test("route GET: RepoView.isSelf decided on the server (ORCH_SELF_REPO set → that repo; unset → SELF_REPO)", async () => {
  const OTHER = "o/second";
  const get = async () => {
    const { GET } = await import("../../app/api/orch/route");
    const r = await GET(new Request("http://localhost/api/orch", { headers: { "x-admin-token": ADMIN } }));
    assert.equal(r.status, 200);
    const j = (await r.json()) as { mode: string; repos: { repo: string; isSelf: boolean }[] };
    assert.equal(j.mode, "live");
    return Object.fromEntries(j.repos.map((v) => [v.repo, v.isSelf]));
  };
  const both = { ...LIVE, ORCH_REPOS: `${REPO},${OTHER}` };
  await withRoute({ ...both, ORCH_SELF_REPO: REPO }, issue(), async () => {
    assert.deepEqual(await get(), { [REPO]: true, [OTHER]: false });
  });
  await withRoute({ ...both, ORCH_SELF_REPO: ` ${OTHER} ` }, issue(), async () => {
    assert.deepEqual(await get(), { [REPO]: false, [OTHER]: true });
  });
  // 없음: SELF_REPO 상수(jonghee1998/ai-orchestrator)와 같은 저장소만 true
  await withRoute({ ...both, ORCH_REPOS: `${REPO},${SELF_REPO}` }, issue(), async () => {
    assert.deepEqual(await get(), { [REPO]: false, [SELF_REPO]: true });
  });
});

const idea = { action: "idea", repo: REPO, title: "상황판 채팅", body: "폰에서 바로 물어보고 싶음" };

test("route POST idea: no admin auth, read-role session or session without CSRF → 401/403 and zero GitHub calls", async () => {
  await withRoute({ ...LIVE, CONTROL_READ_TOKEN: "test-read-token-for-route" }, issue(), async (post, g) => {
    assert.equal((await post(idea)).status, 401);
    assert.equal((await post(idea, { "x-admin-token": "wrong-token-but-long-enough" })).status, 401);
    assert.equal((await post(idea, { "x-admin-token": "test-read-token-for-route" })).status, 401, "read token is not admin");
    assert.equal((await post(idea, { cookie: "orch_session=forged" })).status, 401);
    const admin = issueSession("admin", process.env, Date.now())!;
    const read = issueSession("read", process.env, Date.now())!;
    const same = { host: "localhost", origin: "http://localhost" };
    const ck = (s: typeof admin) => `${cookieName(process.env)}=${s.value}`;
    assert.equal((await post(idea, { ...same, cookie: ck(admin) })).status, 403, "no CSRF token");
    assert.equal((await post(idea, { ...same, cookie: ck(admin), "x-csrf-token": "wrong" })).status, 403);
    assert.equal((await post(idea, { ...same, cookie: ck(admin), origin: "https://evil.example", "x-csrf-token": csrfToken(admin.session, process.env) })).status, 403);
    assert.equal((await post(idea, { ...same, cookie: ck(read), "x-csrf-token": csrfToken(read.session, process.env) })).status, 403, "read role");
    assert.equal(g.calls.length, 0);
    const ok = await post(idea, { ...same, cookie: ck(admin), "x-csrf-token": csrfToken(admin.session, process.env) });
    assert.equal(ok.status, 200, "admin session + CSRF works");
    assert.equal(g.writes().length, 1);
  });
});

test("route POST idea: validates repo/title/body (400), token (503), then creates exactly one Issue", async () => {
  const h = { "x-admin-token": ADMIN };
  await withRoute(LIVE, issue(), async (post, g) => {
    for (const b of [{ ...idea, repo: "x/y" }, { ...idea, title: "" }, { ...idea, title: "  " }, { ...idea, title: "x".repeat(81) }, { ...idea, title: "두\n줄" }, { ...idea, title: 3 }, { ...idea, body: "가".repeat(4001) }, { ...idea, body: 1 }]) {
      assert.equal((await post(b, h)).status, 400, JSON.stringify(b).slice(0, 80));
    }
    assert.equal(g.calls.length, 0, "bad input never reaches GitHub");
    const ok = await post({ ...idea, title: "  상황판 채팅 " }, h);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, issue: 42, url: `https://github.com/${REPO}/issues/42` });
    assert.deepEqual(g.calls, [{ method: "POST", path: `/repos/${REPO}/issues`, body: { title: "[idea] 상황판 채팅", body: idea.body } }]);
    assert.equal((await post({ ...idea, body: "가".repeat(4000) }, h)).status, 200, "a 4000-char body fits the request limit");
    assert.equal((await post({ action: "approve", repo: REPO, issue: 7, hash: H, pad: "x".repeat(3000) }, h)).status, 413, "other actions keep the 2 KB limit");
  });
  await withRoute({ ...LIVE, ORCH_GITHUB_TOKEN: undefined, GITHUB_TOKEN: "read-only-test-token" }, issue(), async (post, g) => {
    const r = await post(idea, h);
    assert.deepEqual([r.status, (await r.json()).error], [503, "write_unconfigured"]);
    assert.equal(g.calls.length, 0);
  });
});

// ---------------------------------------------------------------- route.ts POST switch { scope: "all" }

const R2 = "o/second";
const R3 = "o/third";
const ALL3 = { ...LIVE, ORCH_REPOS: `${REPO},${R2},${R3}`, CONTROL_READ_TOKEN: "test-read-token-for-route" };
const allOff = { key: "codex", value: false, scope: "all" };
const patches = (g: ReturnType<typeof fakeGitHub>) => g.calls.filter((c) => c.method === "PATCH").map((c) => c.path);

test("route POST scope all: admin cookie + CSRF → every repo PATCHed and woken, ok true", async () => {
  await withRoute(ALL3, issue(), async (post, g) => {
    const admin = issueSession("admin", process.env, Date.now())!;
    const h = { host: "localhost", origin: "http://localhost", cookie: `${cookieName(process.env)}=${admin.value}`, "x-csrf-token": csrfToken(admin.session, process.env) };
    const r = await post(allOff, h);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, results: [REPO, R2, R3].map((repo) => ({ repo, saved: true, woke: true })) });
    assert.deepEqual(patches(g), [REPO, R2, R3].map((x) => `/repos/${x}/actions/variables/ORCH_CODEX`));
    assert.ok(g.calls.filter((c) => c.method === "PATCH").every((c) => JSON.stringify(c.body) === JSON.stringify({ name: "ORCH_CODEX", value: "off" })));
    assert.equal(g.calls.filter((c) => c.method === "POST" && c.path.endsWith("/orchestrator.yml/dispatches")).length, 3);
  });
});

test("route POST scope all: read session, missing/wrong CSRF, no auth, bad input, no write token → zero GitHub calls", async () => {
  await withRoute(ALL3, issue(), async (post, g) => {
    const admin = issueSession("admin", process.env, Date.now())!;
    const read = issueSession("read", process.env, Date.now())!;
    const same = { host: "localhost", origin: "http://localhost" };
    const ck = (s: typeof admin) => `${cookieName(process.env)}=${s.value}`;
    assert.equal((await post(allOff)).status, 401);
    assert.equal((await post(allOff, { "x-admin-token": "test-read-token-for-route" })).status, 401, "read token is not admin");
    assert.equal((await post(allOff, { ...same, cookie: ck(admin) })).status, 403, "no CSRF token");
    assert.equal((await post(allOff, { ...same, cookie: ck(admin), "x-csrf-token": "wrong" })).status, 403);
    assert.equal((await post(allOff, { ...same, cookie: ck(read), "x-csrf-token": csrfToken(read.session, process.env) })).status, 403, "read role");
    const h = { ...same, cookie: ck(admin), "x-csrf-token": csrfToken(admin.session, process.env) };
    for (const b of [{ ...allOff, key: "gpt" }, { ...allOff, value: "off" }, { key: "window", value: "25:00-26:00", scope: "all" }, { ...allOff, scope: "every" }, { ...allOff, scope: true }]) {
      assert.equal((await post(b, h)).status, 400, JSON.stringify(b));
    }
    assert.equal(g.calls.length, 0);
  });
  await withRoute({ ...ALL3, ORCH_GITHUB_TOKEN: undefined, GITHUB_TOKEN: "read-only-test-token" }, issue(), async (post, g) => {
    const r = await post(allOff, { "x-admin-token": ADMIN });
    assert.deepEqual([r.status, (await r.json()).error], [503, "write_unconfigured"]);
    assert.equal(g.calls.length, 0);
  });
});

test("route POST scope all: one repo fails to save → the rest continue; wake failure reported as woke false", async () => {
  await withRoute(ALL3, issue(), async (post, g) => {
    const r = await post({ key: "window", value: "08:00-24:00", scope: "all" }, { "x-admin-token": ADMIN });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), {
      ok: false,
      results: [
        { repo: REPO, saved: false, woke: false, error: "권한 없음 또는 저장소 없음" },
        { repo: R2, saved: true, woke: true },
        { repo: R3, saved: true, woke: false },
      ],
    });
    assert.deepEqual(patches(g), [REPO, R2, R3].map((x) => `/repos/${x}/actions/variables/ORCH_WINDOW`), "continued after the failing repo");
    assert.ok(!g.calls.some((c) => c.method === "POST" && c.path === `/repos/${REPO}/actions/workflows/orchestrator.yml/dispatches`), "no wake for an unsaved repo");
  }, { saveFail: { [REPO]: 403 }, wakeFail: [R3] });
});

test("route POST scope all: no configured repos → 200 ok false, results []", async () => {
  await withRoute({ ...LIVE, ORCH_REPOS: undefined }, issue(), async (post, g) => {
    const r = await post(allOff, { "x-admin-token": ADMIN });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: false, results: [] });
    assert.equal(g.calls.length, 0);
  });
});

test("route POST single repo { repo, key, value }: same response contract as before", async () => {
  await withRoute(ALL3, issue(), async (post, g) => {
    const r = await post({ repo: R2, key: "paused", value: true }, { "x-admin-token": ADMIN });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, name: "ORCH_PAUSED", value: "on", woke: true });
    assert.deepEqual(patches(g), [`/repos/${R2}/actions/variables/ORCH_PAUSED`], "only that repo");
    assert.equal((await post({ repo: "x/y", key: "paused", value: true }, { "x-admin-token": ADMIN })).status, 400);
    assert.equal((await post({ repo: R2, key: "paused", value: "on" }, { "x-admin-token": ADMIN })).status, 400);
    assert.equal(patches(g).length, 1);
  });
  await withRoute(ALL3, issue(), async (post) => {
    const r = await post({ repo: REPO, key: "codex", value: false }, { "x-admin-token": ADMIN });
    assert.deepEqual([r.status, (await r.json()).error], [502, "github_error"]);
  }, { saveFail: { [REPO]: 500 } });
  await withRoute({ ...ALL3, ORCH_GITHUB_TOKEN: undefined, GITHUB_TOKEN: "read-only-test-token" }, issue(), async (post, g) => {
    const r = await post({ repo: REPO, key: "codex", value: false }, { "x-admin-token": ADMIN });
    assert.deepEqual([r.status, (await r.json()).error], [503, "write_unconfigured"]);
    assert.equal(g.calls.length, 0);
  });
});

// ---------------------------------------------------------------- repository variables: every page

test("readRepo: switches read across variable pages; a failing page → switches null → mergedSwitches.value null", async () => {
  const filler = Array.from({ length: 100 }, (_, n) => ({ name: `OTHER_${n}`, value: "x" }));
  const second = [{ name: "ORCH_CODEX", value: "off" }, { name: "ORCH_WINDOW", value: "08:00-24:00" }];
  const calls: string[] = [];
  const fakeVars = (page2Status: number, total: number | undefined = 102) => (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const json = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s });
    if ((init?.method ?? "GET") !== "GET") return json(500, {});
    if (u.pathname === `/repos/${REPO}/actions/variables`) {
      calls.push(u.search);
      const page = u.searchParams.get("page");
      if (page === "1") return json(200, { total_count: total, variables: filler });
      if (page === "2") return json(page2Status, page2Status === 200 ? { total_count: total, variables: second } : { message: "no" });
      return json(200, { total_count: total, variables: [] });
    }
    if (u.pathname.endsWith("/issues")) return json(200, []);
    return json(404, {});
  }) as typeof fetch;
  const ok = await readRepo(REPO, { ...ENV, ORCH_SELF_REPO: REPO }, fakeVars(200));
  assert.deepEqual(ok.switches, { sonnet: true, opus: true, codex: false, paused: false, auto: false, codexDev: true, window: "08:00-24:00" });
  assert.deepEqual(calls, ["?per_page=100&page=1", "?per_page=100&page=2"], "stops at total_count");
  assert.deepEqual(mergedSwitches([ok]).value, ok.switches);
  const noTotal = await readRepo(REPO, ENV, fakeVars(200, undefined));
  assert.equal(noTotal.switches?.codex, false, "without total_count a short page ends the listing");
  const bad = await readRepo(REPO, { ...ENV, ORCH_SELF_REPO: REPO }, fakeVars(500));
  assert.equal(bad.switches, null, "never defaults from a partial list");
  assert.ok(bad.switchesError);
  assert.equal(mergedSwitches([bad, { ...ok, repo: "o/other", isSelf: false }]).value, null);
});

// ---------------------------------------------------------------- changes not deployed yet

test("readRepo: deployPending from compare merge commits since prod-deployed; no tag / error → null; no pendingPrs field", async () => {
  const commits = [
    { parents: [{}, {}], commit: { message: "Merge pull request #12 from o/orch/run-10\n\n본문 (#99)" } },
    { parents: [{}], commit: { message: "[run #10] Step 1: 무언가 (#11)" } },
    { parents: [{}], commit: { message: "직접 커밋" } },
    { parents: [{}, {}] },
    null,
  ];
  const fakeRepo = (compare: { status: number; body?: unknown }) => (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const json = (s: number, b: unknown) => new Response(JSON.stringify(b ?? {}), { status: s });
    if ((init?.method ?? "GET") !== "GET") return json(500, {});
    if (u.pathname === `/repos/${REPO}/compare/prod-deployed...main`) return json(compare.status, compare.body);
    if (u.pathname.endsWith("/actions/variables")) return json(200, { variables: [] });
    if (u.pathname.endsWith("/issues")) return json(200, []);
    return json(404, {});
  }) as typeof fetch;
  const ok = await readRepo(REPO, ENV, fakeRepo({ status: 200, body: { commits } }));
  assert.equal(ok.deployPending, 2);
  assert.equal(ok.deployMode, "batch");
  assert.ok(!("pendingPrs" in ok));
  const none = await readRepo(REPO, ENV, fakeRepo({ status: 200, body: { commits: [] } }));
  assert.equal(none.deployPending, 0);
  assert.equal(none.deployMode, "batch");
  const noTag = await readRepo(REPO, ENV, fakeRepo({ status: 404, body: { message: "Not Found" } }));
  assert.equal(noTag.deployPending, null);
  assert.equal(noTag.deployMode, "direct");
  const err = await readRepo(REPO, ENV, fakeRepo({ status: 500 }));
  assert.equal(err.deployPending, null);
  assert.equal(err.deployMode, "unknown");
  const noList = await readRepo(REPO, ENV, fakeRepo({ status: 200, body: { status: "identical" } }));
  assert.equal(noList.deployPending, null);
  assert.equal(noList.deployMode, "unknown");
});

test("readRepo app: ORCH_APP_URLS beats roadmap.json app; missing there → roadmap app; own repo (isSelf) → null", async () => {
  const roadmapApp = { label: "로드맵앱", url: "https://roadmap.example.invalid/" };
  const fakeRepo = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const json = (s: number, b: unknown) => new Response(JSON.stringify(b ?? {}), { status: s });
    if ((init?.method ?? "GET") !== "GET") return json(500, {});
    if (u.pathname.endsWith("/contents/docs/roadmap.json")) {
      return json(200, { encoding: "base64", content: Buffer.from(JSON.stringify({ setup: [], app: roadmapApp })).toString("base64") });
    }
    if (u.pathname.endsWith("/actions/variables")) return json(200, { variables: [] });
    if (u.pathname.endsWith("/issues")) return json(200, []);
    return json(404, {});
  }) as typeof fetch;
  const fromEnv = await readRepo(REPO, { ...ENV, ORCH_SELF_REPO: "o/self", ORCH_APP_URLS: `${REPO}=환경앱|https://app.example.invalid/r` }, fakeRepo);
  assert.deepEqual(fromEnv.app, { label: "환경앱", url: "https://app.example.invalid/r" });
  assert.deepEqual(fromEnv.roadmap!.app, roadmapApp);
  const fallback = await readRepo(REPO, { ...ENV, ORCH_SELF_REPO: "o/self", ORCH_APP_URLS: "o/other=https://app.example.invalid/x" }, fakeRepo);
  assert.deepEqual(fallback.app, roadmapApp);
  const noVar = await readRepo(REPO, { ...ENV, ORCH_SELF_REPO: "o/self" }, fakeRepo);
  assert.deepEqual(noVar.app, roadmapApp);
  const self = await readRepo(REPO, { ...ENV, ORCH_SELF_REPO: REPO, ORCH_APP_URLS: `${REPO}=https://app.example.invalid/self` }, fakeRepo);
  assert.equal(self.isSelf, true);
  assert.equal(self.app, null);
});

// ---------------------------------------------------------------- connection check (readConnection via readRepo)

test("readRepo connection: contents listings + label orch:go (200 / 404 / 500); 500 never throws and keeps other fields", async () => {
  const sha = "a".repeat(40);
  const ent = (name: string, type = "file") => ({ name, type, sha });
  const ENGINE = ["claude-review.yml", "claude-work.yml", "cleanup-branches.yml", "codex-login.yml", "final-sync.yml", "idea-review.yml",
    "orchestrator.yml", "plan-next.yml", "plan-review.yml", "plan-revise.yml", "pm-unblock.yml", "usage.yml", "wait.yml"];
  const P = {
    root: `/repos/${REPO}/contents`,
    docs: `/repos/${REPO}/contents/docs`,
    workflows: `/repos/${REPO}/contents/.github/workflows`,
    scripts: `/repos/${REPO}/contents/scripts`,
    label: `/repos/${REPO}/labels/orch:go`,
  };
  const okBodies: Record<keyof typeof P, unknown> = {
    root: [ent("CLAUDE.md"), ent("AGENTS.md"), ent("docs", "dir")],
    docs: [ent("roadmap.json"), ent("architecture.json"), ent("PM_HANDOFF.md")],
    workflows: [...ENGINE.map((n) => ent(n)), ent("ci.yml")],
    scripts: [ent("orch", "dir")],
    label: { name: "orch:go" },
  };
  const roadmap = { setup: [{ id: "0.1", title: "준비", status: "done" }] };
  const runIssue = { number: 5, title: "[orch] 실행", body: body(), state: "open", labels: [{ name: "orch:run" }], html_url: `https://github.com/${REPO}/issues/5`, updated_at: "2026-01-01T00:00:00Z", user: { login: "o" } };
  const seen: string[] = [];
  const fake = (status: Partial<Record<keyof typeof P, number>>) => (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const json = (s: number, b: unknown) => new Response(JSON.stringify(b ?? {}), { status: s });
    if ((init?.method ?? "GET") !== "GET") return json(500, {});
    seen.push(u.pathname);
    for (const k of Object.keys(P) as (keyof typeof P)[]) {
      if (u.pathname === P[k]) {
        const s = status[k] ?? 200;
        return json(s, s === 200 ? okBodies[k] : { message: "x" });
      }
    }
    if (u.pathname.endsWith("/contents/docs/roadmap.json")) {
      return json(200, { encoding: "base64", content: Buffer.from(JSON.stringify(roadmap)).toString("base64") });
    }
    if (u.pathname.endsWith("/actions/variables")) return json(200, { variables: [] });
    if (u.pathname.endsWith("/issues")) return json(200, u.searchParams.get("labels") === "orch:run" ? [runIssue] : []);
    return json(404, {});
  }) as typeof fetch;
  const ok = (c: { items: { key: string; ok: boolean | null }[] }, key: string) => c.items.find((i) => i.key === key)!.ok;

  const all = await readRepo(REPO, ENV, fake({}));
  assert.ok(seen.includes(P.label), "label pathname is the unencoded /labels/orch:go");
  assert.ok(all.connection);
  assert.equal(all.connection.done, 9);
  assert.equal(all.connection.total, 9);
  assert.equal(all.connection.engine.orchSha, sha);

  const missing = await readRepo(REPO, ENV, fake({ docs: 404, workflows: 404, label: 404 }));
  assert.equal(ok(missing.connection!, "roadmap"), false);
  assert.equal(ok(missing.connection!, "workflows"), false);
  assert.equal(ok(missing.connection!, "ci"), false);
  assert.equal(ok(missing.connection!, "label"), false);
  assert.equal(ok(missing.connection!, "claude"), true);
  assert.equal(missing.connection!.total, 9);

  const base = await readRepo(REPO, ENV, fake({}));
  const err = await readRepo(REPO, ENV, fake({ root: 500, docs: 500, workflows: 500, scripts: 500, label: 500 }));
  for (const k of ["workflows", "ci", "orch", "claude", "agents", "roadmap", "architecture", "handoff", "label"]) assert.equal(ok(err.connection!, k), null, k);
  assert.equal(err.connection!.total, 0);
  assert.equal(err.connection!.engine.orchSha, null);
  assert.deepEqual(err.runs, base.runs);
  assert.equal(err.runs.length, 1);
  assert.equal(err.runsError, null);
  assert.deepEqual(err.roadmap, base.roadmap);
  assert.ok(err.roadmap);
  assert.equal(err.roadmapError, null);
  assert.deepEqual(err.switches, base.switches);
  assert.equal(err.deployMode, base.deployMode);

  const notArray = await readRepo(REPO, ENV, (async (url: string, init?: RequestInit) => {
    if (new URL(url).pathname === P.scripts) return new Response(JSON.stringify({ name: "scripts", type: "file", sha }), { status: 200 });
    return fake({})(url, init);
  }) as typeof fetch);
  assert.equal(ok(notArray.connection!, "orch"), null, "non-array listing = could not check");
});

// ---------------------------------------------------------------- docs/architecture.json (readArchitecture + GET /api/architecture)

const ARCH = { version: 1, purpose: "예시 목적", sections: [{ no: "01", kicker: "개요", title: "한눈에", blocks: [{ type: "text", lines: ["문장"] }] }] };
const BIG_ARCH = JSON.stringify({ ...ARCH, pad: "a".repeat(ARCH_MAX_BYTES) });
const archFile = (text: string, extra: Record<string, unknown> = {}) => ({
  status: 200,
  // GitHub wraps base64 content every 60 chars.
  body: { size: Buffer.byteLength(text), encoding: "base64", content: Buffer.from(text).toString("base64").replace(/(.{60})/g, "$1\n"), ...extra },
});
const archFake = (file: { status: number; body?: unknown }) => fakeGitHub(issue(), [], { architecture: { [REPO]: file } }).f;

test("readArchitecture: file → parsed; 404 → null; malformed / no content → ArchitectureFormatError; 500 → GitHubError", async () => {
  const ok = fakeGitHub(issue(), [], { architecture: { [REPO]: archFile(JSON.stringify(ARCH)) } });
  assert.deepEqual(await readArchitecture(REPO, ENV, ok.f), ARCH);
  assert.deepEqual(ok.calls.map((c) => `${c.method} ${c.path}`), [`GET /repos/${REPO}/contents/docs/architecture.json`]);
  assert.equal(await readArchitecture(REPO, ENV, fakeGitHub(issue()).f), null, "404 = no file");
  for (const file of [archFile("not json"), archFile(JSON.stringify({ version: 1, sections: [] })), archFile("{}", { content: undefined }), archFile("{}", { encoding: "none" })]) {
    await assert.rejects(readArchitecture(REPO, ENV, archFake(file)), (e) => e instanceof ArchitectureFormatError && !/크기/.test(e.message));
  }
  await assert.rejects(readArchitecture(REPO, ENV, archFake({ status: 500 })), (e) => e instanceof GitHubError && e.status === 500);
});

test("readArchitecture: over 65,536 bytes rejected by size metadata or by base64 length (before decoding)", async () => {
  const tooBig = (file: { status: number; body: unknown }) =>
    assert.rejects(readArchitecture(REPO, ENV, archFake(file)), (e) => e instanceof ArchitectureFormatError && /크기 초과/.test(e.message));
  await tooBig(archFile(JSON.stringify(ARCH), { size: ARCH_MAX_BYTES + 1 }));
  await tooBig(archFile(BIG_ARCH, { size: undefined }));
  await tooBig(archFile(BIG_ARCH, { size: 10 }));
});

const READ = "test-read-token-for-route";
const ARCH_ENV = { ...LIVE, ORCH_REPOS: `${REPO},${R2},${R3}`, CONTROL_READ_TOKEN: READ };
type ArchJson = { repos: { repo: string; architecture: unknown; error: string | null }[] };
async function getArch(h: Record<string, string> = { "x-admin-token": READ }) {
  const { GET } = await import("../../app/api/architecture/route");
  return GET(new Request("http://localhost/api/architecture", { headers: h }));
}

test("route GET /api/architecture: needs read auth; responses are no-store", async () => {
  await withRoute(ARCH_ENV, issue(), async (_post, g) => {
    for (const h of [{}, { "x-admin-token": "wrong-token-but-long-enough" }, { cookie: "orch_session=forged" }] as Record<string, string>[]) {
      const r = await getArch(h);
      assert.equal(r.status, 401, JSON.stringify(h));
      assert.equal(r.headers.get("cache-control"), "no-store");
    }
    assert.equal(g.calls.length, 0, "no GitHub call without auth");
    const ok = await getArch();
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("cache-control"), "no-store");
    assert.equal(g.writes().length, 0, "read only");
  });
});

test("route GET /api/architecture: own repo (ORCH_SELF_REPO) skipped; one repo's 500 does not hide others; >64KB rejected", async () => {
  const opts: FakeOpts = { architecture: { [REPO]: archFile(JSON.stringify(ARCH)), [R2]: { status: 500 }, [R3]: archFile(BIG_ARCH) } };
  await withRoute({ ...ARCH_ENV, ORCH_REPOS: `${REPO},${R2},o/self,${R3}`, ORCH_SELF_REPO: " o/self " }, issue(), async (_post, g) => {
    const r = await getArch();
    assert.equal(r.status, 200);
    const j = (await r.json()) as ArchJson;
    assert.deepEqual(j.repos.map((x) => x.repo), [REPO, R2, R3], "own repo is not in the list");
    assert.deepEqual(j.repos[0], { repo: REPO, architecture: ARCH, error: null });
    assert.deepEqual(j.repos[1], { repo: R2, architecture: null, error: "GitHub 오류 500" });
    assert.equal(j.repos[2].architecture, null);
    assert.match(j.repos[2].error ?? "", /크기 초과/);
    assert.ok(!g.calls.some((c) => c.path.startsWith("/repos/o/self/")), "own repo's file is never read");
  }, opts);
  // ORCH_SELF_REPO unset → SELF_REPO is the own repo; a repo without the file → architecture null, error null.
  await withRoute({ ...ARCH_ENV, ORCH_REPOS: `${SELF_REPO},${R2}` }, issue(), async (_post, g) => {
    const j = (await (await getArch()).json()) as ArchJson;
    assert.deepEqual(j.repos, [{ repo: R2, architecture: null, error: null }]);
    assert.ok(!g.calls.some((c) => c.path.startsWith(`/repos/${SELF_REPO}/`)));
  });
});

test("route GET /api/architecture: no read token → every repo gets an error and GitHub is not called", async () => {
  await withRoute({ ...ARCH_ENV, ORCH_GITHUB_TOKEN: undefined }, issue(), async (_post, g) => {
    const j = (await (await getArch()).json()) as ArchJson;
    assert.deepEqual(j.repos.map((x) => [x.repo, x.architecture, Boolean(x.error)]), [[REPO, null, true], [R2, null, true], [R3, null, true]]);
    assert.equal(g.calls.length, 0);
  });
});
