import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ideaHash, parseIdea, type IdeaComment, type IdeaIssue } from "./ideas";
import { readRepo } from "./github";

const REPO = "o/r";
const BOT = { id: 41898282, type: "Bot", login: "github-actions[bot]" };
const HUMAN = { id: 1, type: "User", login: "o" };
const issue = (extra: Partial<IdeaIssue> = {}): IdeaIssue => ({
  number: 9, title: "[idea] 상황판 채팅", body: "폰에서 바로 물어보고 싶음", html_url: `https://github.com/${REPO}/issues/9`,
  state: "open", created_at: "2026-11-20T01:00:00Z", user: { login: "o" }, ...extra,
});
const H = "57e1f32b956025f9";
const op = { value: "high", effort: "S", risk: "low", steps: 2, recommend: "now", reasons: "<바로> 쓸모 있음" };
/** Same escaping as idea-review.mjs reviewComment. */
const marker = (m: Record<string, unknown>) =>
  `<!-- orch-idea:v1 ${JSON.stringify(m).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/\n/g, "\\n")} -->\n### 💡 종합 의견`;
const review = (extra: Record<string, unknown> = {}) =>
  ({ hash: H, recommend: "now", summary: "지금 하자\n두 의견 같음", agree: "가치 높음", disagree: "", claude: op, codex: op, codexPending: false, ...extra });
const comment = (m: Record<string, unknown>, user: IdeaComment["user"] = BOT, at = "2026-11-20T02:00:00Z"): IdeaComment => ({ user, body: marker(m), created_at: at });

type Engine = { ideaHash: (t: string, b: string | null) => string };
const load = (rel: string) => (new Function("p", "return import(p)") as (p: string) => Promise<Engine>)(pathToFileURL(path.resolve(rel)).href);

test("ideas: hash matches the fixed vectors and scripts/orch/idea-review.mjs ideaHash", async () => {
  assert.equal(ideaHash("[idea] 상황판 채팅", "폰에서 바로 물어보고 싶음"), "57e1f32b956025f9");
  assert.equal(ideaHash("[idea] 빈 본문", null), "b8a97170da4301be");
  assert.equal(ideaHash("[idea] 빈 본문", undefined), "b8a97170da4301be");
  const engine = await load("scripts/orch/idea-review.mjs");
  for (const [t, b] of [["[idea] 상황판 채팅", "폰에서 바로 물어보고 싶음"], ["[idea] 빈 본문", null], ["[idea] x", "a\r\nb\n"], ["[idea]붙임", ""]] as [string, string | null][]) {
    assert.equal(ideaHash(t, b), engine.ideaHash(t, b), JSON.stringify([t, b]));
  }
});

test("ideas: four statuses — collecting, done, codex_pending, stale", () => {
  const c = parseIdea(REPO, issue(), [])!;
  assert.deepEqual(c, {
    repo: REPO, number: 9, url: `https://github.com/${REPO}/issues/9`, title: "상황판 채팅", mine: "폰에서 바로 물어보고 싶음",
    createdAt: "2026-11-20T01:00:00Z", closed: false, status: "collecting", review: null,
  });
  const d = parseIdea(REPO, issue(), [comment(review())])!;
  assert.equal(d.status, "done");
  assert.deepEqual(d.review, {
    recommend: "now", summary: "지금 하자\n두 의견 같음", agree: "가치 높음", disagree: "", at: "2026-11-20T02:00:00Z",
    claude: op, codex: op,
  }, "escaped < > and \\n come back as text");
  const p = parseIdea(REPO, issue(), [comment(review({ codex: null, codexPending: true }))])!;
  assert.equal(p.status, "codex_pending");
  assert.equal(p.review!.codex, null);
  assert.equal(parseIdea(REPO, issue({ body: "본문을 고침" }), [comment(review())])!.status, "stale");
  assert.equal(parseIdea(REPO, issue({ title: "[idea] 제목을 고침" }), [comment(review())])!.status, "stale");
  assert.equal(parseIdea(REPO, issue({ title: "[idea] 빈 본문", body: null }), [comment(review({ hash: "b8a97170da4301be" }))])!.status, "done");
});

test("ideas: only the Actions bot's last marker counts; people's markers are ignored", () => {
  assert.equal(parseIdea(REPO, issue(), [comment(review(), HUMAN)])!.status, "collecting", "forged by a person");
  assert.equal(parseIdea(REPO, issue(), [comment(review(), { id: 41898282, type: "User" })])!.status, "collecting", "bot id but not Bot type");
  const late = parseIdea(REPO, issue(), [comment(review({ hash: "0000000000000000" })), comment(review({ recommend: "hold" }), HUMAN), comment(review({ recommend: "later" }), BOT, "2026-11-21T00:00:00Z")])!;
  assert.deepEqual([late.status, late.review!.recommend, late.review!.at], ["done", "later", "2026-11-21T00:00:00Z"]);
  const humanLast = parseIdea(REPO, issue(), [comment(review()), comment(review({ hash: "0000000000000000" }), HUMAN)])!;
  assert.equal(humanLast.status, "done", "a later human marker does not make it stale");
  const broken = parseIdea(REPO, issue(), [{ user: BOT, body: "<!-- orch-idea:v1 {broken} -->" }])!;
  assert.equal(broken.status, "collecting");
});

test("ideas: owner-authored '[idea]' Issues only (no PRs); closed and long bodies", () => {
  assert.equal(parseIdea(REPO, issue({ user: { login: "someone" } }), []), null, "not the repo owner");
  assert.equal(parseIdea(REPO, issue({ user: null }), []), null);
  assert.equal(parseIdea(REPO, issue({ pull_request: {} }), []), null);
  assert.equal(parseIdea(REPO, issue({ title: "[plan] x" }), []), null);
  assert.equal(parseIdea(REPO, issue({ title: "아이디어 [idea]" }), []), null);
  const closed = parseIdea(REPO, issue({ state: "closed", body: "가".repeat(5000) }), [])!;
  assert.equal(closed.closed, true);
  assert.equal(closed.mine.length, 4000);
  assert.equal(parseIdea(REPO, issue({ body: null }), [])!.mine, "");
});

test("readRepo: ideas + ideasError; newest 15 '[idea]' Issues from one list request; failure leaves the rest intact", async () => {
  const calls: string[] = [];
  const ideas = Array.from({ length: 20 }, (_, i) => issue({ number: 200 - i, title: `[idea] 항목 ${i}` }));
  const list = [issue({ number: 300, title: "[plan] 계획" }), issue({ number: 301, user: { login: "x" } }), issue({ number: 302, pull_request: {} }), ...ideas];
  const mk = (failIdeas: boolean) => (async (url: string, init?: RequestInit) => {
    const u = new URL(url); const m = init?.method ?? "GET";
    calls.push(`${m} ${u.pathname}${u.search}`);
    const json = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s });
    if (m !== "GET") return json(500, {});
    if (u.pathname.endsWith("/issues") && u.searchParams.get("labels")) return json(200, []);
    if (u.pathname.endsWith("/issues") && u.searchParams.get("state") === "all") return failIdeas ? json(403, {}) : json(200, list);
    if (u.pathname.endsWith("/issues")) return json(200, []);
    if (u.pathname.endsWith("/issues/200/comments")) return json(200, [comment(review({ hash: ideaHash("[idea] 항목 0", ideas[0].body) }))]);
    if (u.pathname.endsWith("/comments")) return json(200, []);
    if (u.pathname.endsWith("/actions/variables")) return json(200, { variables: [] });
    return json(404, {});
  }) as typeof fetch;

  const v = await readRepo(REPO, { ORCH_GITHUB_TOKEN: "t" }, mk(false));
  assert.equal(v.ideasError, null);
  assert.deepEqual(v.ideas.map((i) => i.number), Array.from({ length: 15 }, (_, i) => 200 - i), "non-ideas skipped, at most 15, list order kept");
  assert.deepEqual([v.ideas[0].status, v.ideas[1].status], ["done", "collecting"]);
  assert.ok(calls.includes(`GET /repos/${REPO}/issues?state=all&sort=created&direction=desc&per_page=50`));
  assert.ok(calls.includes(`GET /repos/${REPO}/issues/200/comments?per_page=100`));
  assert.equal(calls.filter((c) => /\/issues\/\d+\/comments/.test(c)).length, 15);
  assert.ok(calls.every((c) => c.startsWith("GET ")), "reads only");

  const bad = await readRepo(REPO, { ORCH_GITHUB_TOKEN: "t" }, mk(true));
  assert.deepEqual(bad.ideas, []);
  assert.match(bad.ideasError!, /권한/);
  assert.ok(bad.switches);
  assert.deepEqual([bad.runsError, bad.switchesError, bad.plansError], [null, null, null]);
});
