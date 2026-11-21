import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import Module from "node:module";
import { approvePlan, createIdea, GitHubError } from "./github";
import { parsePlan, planHash, type PlanComment, type PlanIssue } from "./plans";
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
function fakeGitHub(i: PlanIssue, comments: PlanComment[] = [], opts: { labelStatus?: number; issueStatus?: number } = {}) {
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
async function withRoute(env: Record<string, string | undefined>, i: PlanIssue, run: (post: (b: unknown, h?: Record<string, string>) => Promise<Response>, g: ReturnType<typeof fakeGitHub>) => Promise<void>) {
  const keys = ["ORCH_REPOS", "GITHUB_REPO", "ORCH_GITHUB_TOKEN", "GITHUB_READ_TOKEN", "GITHUB_TOKEN", "CONTROL_ADMIN_TOKEN", "CONTROL_READ_TOKEN"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const savedFetch = globalThis.fetch;
  const g = fakeGitHub(i);
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
