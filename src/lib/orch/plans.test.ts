import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parsePendingPlan, parsePlan, planHash, type PlanComment, type PlanIssue } from "./plans";
import { readRepo } from "./github";

const REPO = "o/r";
const BOT = { id: 41898282, type: "Bot", login: "github-actions[bot]" };
const plan = { goal: "목표", steps: [{ id: 1, title: "t1", task: "x", done_when: ["npm test 통과"] }, { id: 2, title: "t2", task: "y", done_when: ["ok"] }] };
const body = (p: unknown = plan) => "설명\n\n```json\n" + JSON.stringify(p) + "\n```";
const issue = (extra: Partial<PlanIssue> = {}): PlanIssue => ({
  number: 7, title: "[plan] 계획", body: body(), html_url: `https://github.com/${REPO}/issues/7`, state: "open", labels: [], user: { login: "o" }, ...extra,
});
const marker = (round: number, hash: string, verdict = "REVISE", reviewer = "codex") =>
  `<!-- orch-plan-review:v1 ${JSON.stringify({ round, hash, verdict, reviewer, findings: [] })} -->\n### 계획 감사`;
const comment = (round: number, hash: string, verdict = "REVISE", user: PlanComment["user"] = BOT, at = `2026-11-2${round}T00:00:00Z`): PlanComment =>
  ({ user, body: marker(round, hash, verdict), created_at: at });
const H = planHash((parsePlan(body()) as { ok: true; plan: Parameters<typeof planHash>[0] }).plan);

test("plans: a valid owner plan is pending, with its latest bot review", () => {
  const p = parsePendingPlan(REPO, issue(), [comment(1, H, "OK")])!;
  assert.deepEqual(
    { ...p, review: p.review },
    { repo: REPO, number: 7, url: `https://github.com/${REPO}/issues/7`, goal: "목표", steps: 2, hash: H, phase: null,
      review: { round: 1, verdict: "OK", reviewer: "codex", at: "2026-11-21T00:00:00Z", hash: H, stale: false } },
  );
  assert.match(p.hash, /^[0-9a-f]{16}$/);
  assert.equal(parsePendingPlan(REPO, issue(), [])!.review, null, "no review yet");
});

test("plans: non-owner author, stop labels, non-[plan] title, closed, PR, broken JSON are not pending", () => {
  assert.equal(parsePendingPlan(REPO, issue({ user: { login: "someone" } }), []), null, "only the repo owner's plans (engine rule)");
  assert.equal(parsePendingPlan(REPO, issue({ user: null }), []), null);
  for (const l of ["orch:go", "orch:run", "orch:done", "orch:blocked", "orch:cancel"]) {
    assert.equal(parsePendingPlan(REPO, issue({ labels: [{ name: l }] }), []), null, l);
    assert.equal(parsePendingPlan(REPO, issue({ labels: [l] }), []), null, `${l} (string label)`);
  }
  assert.ok(parsePendingPlan(REPO, issue({ labels: [{ name: "enhancement" }] }), []), "other labels are fine");
  assert.equal(parsePendingPlan(REPO, issue({ title: "계획 [plan]" }), []), null);
  assert.equal(parsePendingPlan(REPO, issue({ title: "[Plan] x" }), []), null);
  assert.equal(parsePendingPlan(REPO, issue({ state: "closed" }), []), null);
  assert.equal(parsePendingPlan(REPO, issue({ pull_request: {} }), []), null);
  assert.equal(parsePendingPlan(REPO, issue({ body: "```json\n{ goal: 깨짐\n```" }), []), null, "broken JSON");
  assert.equal(parsePendingPlan(REPO, issue({ body: "계획 없음" }), []), null, "no json block");
  assert.equal(parsePendingPlan(REPO, issue({ body: body({ goal: "g" }) }), []), null, "no steps");
});

test("plans: forged markers by people are ignored; the last round wins; changed plan → stale", () => {
  const human = { id: 1, type: "User", login: "o" };
  const forged = parsePendingPlan(REPO, issue(), [comment(1, H, "REVISE"), comment(2, H, "OK", human), comment(3, H, "OK", { id: 41898282, type: "User" })])!;
  assert.deepEqual([forged.review!.round, forged.review!.verdict], [1, "REVISE"], "only Bot id 41898282 counts");
  assert.equal(parsePendingPlan(REPO, issue(), [comment(1, H, "OK", human)])!.review, null);

  const multi = parsePendingPlan(REPO, issue(), [comment(1, "aaaa", "REVISE"), comment(3, H, "OK"), comment(2, "bbbb", "REVISE"), { user: BOT, body: "그냥 댓글" }, { user: BOT, body: "<!-- orch-plan-review:v1 {broken -->" }])!;
  assert.deepEqual([multi.review!.round, multi.review!.verdict, multi.review!.stale], [3, "OK", false]);
  assert.equal(parsePendingPlan(REPO, issue(), [comment(1, H, "weird")])!.review!.verdict, "ERROR");

  const edited = parsePendingPlan(REPO, issue({ body: body({ ...plan, goal: "바뀐 목표" }) }), [comment(1, H, "OK")])!;
  assert.notEqual(edited.hash, H);
  assert.deepEqual([edited.review!.hash, edited.review!.stale], [H, true]);
});

type Engine = { parsePlan: (b: string) => { ok: boolean; plan?: unknown; error?: string }; planHash?: (p: unknown) => string };
const load = (rel: string) => (new Function("p", "return import(p)") as (p: string) => Promise<Engine>)(pathToFileURL(path.resolve(rel)).href);

test("plans: top-level phase is read from the raw JSON and never changes the hash", () => {
  const withPhase = (phase: unknown) => parsePendingPlan(REPO, issue({ body: body({ ...plan, phase }) }), [])!;
  const base = parsePendingPlan(REPO, issue(), [])!;
  assert.equal(base.phase, null);
  assert.equal(withPhase("6").phase, "6");
  assert.equal(withPhase(6).phase, "6");
  assert.equal(withPhase("12345678901").phase, null);
  assert.equal(withPhase({}).phase, null);
  for (const v of ["6", 6, "12345678901", {}]) assert.equal(withPhase(v).hash, base.hash);
  assert.equal(planHash((parsePlan(body({ ...plan, phase: "6" })) as { plan: Parameters<typeof planHash>[0] }).plan), base.hash);
});

test("plans: validation, normalization and hash match the engine (core.mjs parsePlan + plan-review.mjs planHash)", async () => {
  const core = await load("scripts/orch/core.mjs");
  const review = await load("scripts/orch/plan-review.mjs");
  const step = (id: number, extra: object = {}) => ({ id, title: ` t${id} `, task: ` task ${id} `, done_when: [" a ", "b"], ...extra });
  const valid: unknown[] = [
    plan,
    { goal: " g ", context: " c ", steps: [step(1)] },
    { goal: "g", model: "opus", steps: [step(1, { model: "sonnet" }), step(2)] },
    { goal: "g", auto_merge: false, max_retries: 0, steps: [step(1)] },
    { goal: "g", auto_merge: true, max_retries: 3, try: " 시도 ", steps: [step(1, { stop_if: [" s1 ", "s2"] })] },
    { goal: "g", max_retries: null, context: "", try: "", steps: [step(1, { stop_if: [] })] },
    { steps: [step(1)], goal: "key order differs", extra: "ignored" },
    { goal: "g", steps: Array.from({ length: 10 }, (_, i) => step(i + 1)) },
  ];
  const invalid: unknown[] = [
    null, [], "str", {},
    { goal: " ", steps: [step(1)] },
    { goal: "g" }, { goal: "g", steps: [] }, { goal: "g", steps: "x" },
    { goal: "g", steps: Array.from({ length: 11 }, (_, i) => step(i + 1)) },
    { goal: "g", steps: [null] },
    { goal: "g", steps: [step(2)] }, { goal: "g", steps: [step(1), step(3)] }, { goal: "g", steps: [step(1, { id: "1" })] },
    { goal: "g", steps: [step(1, { title: "" })] }, { goal: "g", steps: [step(1, { task: 3 })] },
    { goal: "g", steps: [step(1, { done_when: [] })] }, { goal: "g", steps: [step(1, { done_when: ["ok", " "] })] }, { goal: "g", steps: [step(1, { done_when: "x" })] },
    { goal: "g", steps: [step(1, { stop_if: "x" })] }, { goal: "g", steps: [step(1, { stop_if: null })] }, { goal: "g", steps: [step(1, { stop_if: [""] })] },
    { goal: "g", max_retries: 4, steps: [step(1)] }, { goal: "g", max_retries: -1, steps: [step(1)] }, { goal: "g", max_retries: 1.5, steps: [step(1)] }, { goal: "g", max_retries: "2", steps: [step(1)] },
    { goal: "g", model: "Opus", steps: [step(1)] }, { goal: "g", model: null, steps: [step(1)] }, { goal: "g", model: "-x", steps: [step(1)] }, { goal: "g", model: "a".repeat(65), steps: [step(1)] },
    { goal: "g", steps: [step(1, { model: "bad model" })] }, { goal: "g", steps: [step(1, { model: null })] },
    { goal: "g", auto_merge: "true", steps: [step(1)] }, { goal: "g", auto_merge: null, steps: [step(1)] },
    { goal: "g", try: 1, steps: [step(1)] }, { goal: "g", try: "x".repeat(2001), steps: [step(1)] },
  ];
  const bodies = [...valid, ...invalid].map((p) => body(p));
  bodies.push("no block", "```json\n{ broken\n```", "```json title\n" + JSON.stringify(plan) + "\n```");
  let ok = 0;
  for (const b of bodies) {
    const mine = parsePlan(b), theirs = core.parsePlan(b);
    assert.equal(mine.ok, theirs.ok, b);
    if (!mine.ok || !theirs.ok) { assert.equal(!mine.ok && mine.error, theirs.error, b); continue; }
    ok++;
    assert.deepEqual(mine.plan, theirs.plan, b);
    assert.equal(JSON.stringify(mine.plan), JSON.stringify(theirs.plan), "same field order (feeds the hash)");
    assert.equal(planHash(mine.plan), review.planHash!(theirs.plan), b);
  }
  assert.equal(ok, valid.length + 1, "all valid plans (plus the titled block) compared");
  const pending = parsePendingPlan(REPO, issue({ body: body(valid[4]) }), [])!;
  assert.equal(pending.hash, review.planHash!(core.parsePlan(body(valid[4])).plan));
});

test("readRepo: plans + plansError alongside runs/switches/usage; plan failure leaves the rest intact", async () => {
  const calls: string[] = [];
  const many = Array.from({ length: 8 }, (_, i) => issue({ number: 100 + i, html_url: `u${100 + i}` }));
  const list = [issue({ number: 1, user: { login: "x" } }), issue({ number: 2, labels: [{ name: "orch:go" }] }), issue({ number: 3, body: "no plan" }), ...many];
  const mk = (failPlans: boolean) => (async (url: string, init?: RequestInit) => {
    const u = new URL(url); const m = init?.method ?? "GET";
    calls.push(`${m} ${u.pathname}${u.search}`);
    const json = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s });
    if (m !== "GET") return json(500, {});
    if (u.pathname.endsWith("/issues") && u.searchParams.get("labels")) return json(200, []);
    if (u.pathname.endsWith("/issues")) return failPlans ? json(403, {}) : json(200, list);
    if (u.pathname.endsWith("/issues/100/comments")) return json(200, [comment(1, H, "OK")]);
    if (u.pathname.endsWith("/comments")) return json(200, []);
    if (u.pathname.endsWith("/actions/variables")) return json(200, { variables: [{ name: "ORCH_PAUSED", value: "on" }] });
    return json(404, {});
  }) as typeof fetch;

  const v = await readRepo(REPO, { ORCH_GITHUB_TOKEN: "t" }, mk(false));
  assert.equal(v.plansError, null);
  assert.deepEqual(v.plans.map((p) => p.number), [100, 101, 102, 103, 104], "non-candidates skipped, at most 5");
  assert.equal(v.plans[0].review!.verdict, "OK");
  assert.equal(calls.filter((c) => c.includes("/comments")).length, 5, "comments only for chosen candidates");
  assert.ok(calls.includes(`GET /repos/${REPO}/issues?state=open&per_page=30`));
  assert.ok(calls.includes(`GET /repos/${REPO}/issues/100/comments?per_page=100`));
  assert.deepEqual([v.runs, v.runsError, v.switchesError, v.usage], [[], null, null, null]);
  assert.ok(v.switches);
  assert.ok(calls.every((c) => c.startsWith("GET ")), "reads only");

  const bad = await readRepo(REPO, { ORCH_GITHUB_TOKEN: "t" }, mk(true));
  assert.deepEqual(bad.plans, []);
  assert.match(bad.plansError!, /권한/);
  assert.ok(bad.switches);
  assert.deepEqual([bad.runsError, bad.switchesError], [null, null]);
});

type Fixtures = { REPO: string; githubFixtures: (now: Date) => (m: string, u: URL) => { status: number; body: unknown } | null };

test("screens fixture (scripts/screens/fixtures.mjs): one pending plan, audit OK 2/3, not stale; runs not listed as plans", async () => {
  const fx = await (load("scripts/screens/fixtures.mjs") as unknown as Promise<Fixtures>);
  const gh = fx.githubFixtures(new Date());
  const calls: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const m = init?.method ?? "GET";
    calls.push(m);
    const hit = gh(m, new URL(url));
    return new Response(JSON.stringify(hit?.body ?? { message: "Not Found" }), { status: hit?.status ?? 404 });
  }) as typeof fetch;
  const v = await readRepo(fx.REPO, { ORCH_GITHUB_TOKEN: "t" }, f);
  assert.equal(v.plansError, null);
  assert.deepEqual(v.plans.map((p) => [p.number, p.goal, p.steps]), [[13, "승인 기다리는 시험 계획", 2]]);
  assert.deepEqual([v.plans[0].review?.verdict, v.plans[0].review?.round, v.plans[0].review?.stale], ["OK", 2, false]);
  assert.ok(v.runs.some((r) => r.number === 12), "runs still read");
  assert.ok(calls.every((m) => m === "GET"));
});
