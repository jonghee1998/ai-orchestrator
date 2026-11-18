// Issue #180 — root-wide event fan-out + ONE per-PR writer lock. Real router -> refreshPr -> runCheck path against a complete fake API.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { targetsFromEvent, handleEvent, refreshPr } from "./event-route.mjs";
import { createPrLock, LOCK_GROUP } from "./pr-lock.mjs";
import { runCheck } from "./check.mjs";

const OWNER = { login: "jonghee1998", id: 129052128, type: "User" };
const DEV = { login: "jonghee1998", id: 129052128, type: "User" }; // #182: real PR author is the trusted PM writer (supersedes marker is trusted-PM only)
const BR = "codex/issue-92-mobile-v2", AL = [BR];
const T = (h) => `2026-11-18T0${h}:00:00Z`;
const mark = (root) => `<!-- orch-root-request:v1 #${root} -->`;
const iss = (number, root, extra = {}) => ({ number, user: OWNER, body: root ? mark(root) : "plain", created_at: T(0), updated_at: T(0), ...extra });
const pr = (number, linked, o = {}) => ({ number, state: "open", user: DEV, head: { sha: String(number % 10).repeat(40), repo: { full_name: "o/r" } }, base: { ref: BR, repo: { full_name: "o/r" } }, body: `Closes #${linked}`, created_at: T(2), updated_at: T(2), ...o });

// root 1 (self) with revision issue 2 + independent chain issue 3; PRs 5(#1) 6(#2) 7(#3); unrelated root 50 with PR 8(#50)
function world(over = {}) {
  const issues = { 1: iss(1, 1), 2: iss(2, 1), 3: iss(3, 1), 50: iss(50, 50), 60: iss(60, 0), ...over.issues };
  const pulls = over.pulls ?? [pr(5, 1), pr(6, 2), pr(7, 3), pr(8, 50)];
  return {
    getIssue: async (n) => { if (over.getIssueFail === n) throw new Error("GitHub GET 403"); return issues[n] ?? { number: n, user: OWNER, body: "plain" }; },
    getPull: async (n) => pulls.find((p) => p.number === n) ?? { number: n, state: "open", user: DEV, head: { sha: "9".repeat(40), repo: { full_name: "o/r" } }, base: { ref: BR, repo: { full_name: "o/r" } }, body: "Closes #1\n<!-- orch-supersedes:v1 none -->" },
    listPulls: async () => { if (over.listPulls) return over.listPulls(); return pulls; },
  };
}
const ev = (name, number, isPr = false) => ({ name, payload: name === "pull_request_target" ? { pull_request: { number } } : { issue: { number, ...(isPr ? { pull_request: {} } : {}) } } });

test("#180 S1/S3 root-issue, revision-issue and sibling-chain events refresh ALL eligible PRs of the root (not only the linked one); unrelated root untouched", async () => {
  for (const n of [1, 2, 3]) {
    const r = await targetsFromEvent({ ...ev("issue_comment", n), gh: world(), allowlist: AL });
    assert.deepEqual(r.targets, [5, 6, 7], `issue ${n}`);
    assert.equal(r.error, undefined);
  }
  const u = await targetsFromEvent({ ...ev("issues", 50), gh: world(), allowlist: AL });
  assert.deepEqual(u.targets, [8]);
});
test("#180 S2 sibling PR comment / body event fans out to every PR of the root; dispatch stays single", async () => {
  assert.deepEqual((await targetsFromEvent({ ...ev("issue_comment", 6, true), gh: world(), allowlist: AL })).targets, [5, 6, 7]);
  assert.deepEqual((await targetsFromEvent({ ...ev("pull_request_target", 7), gh: world(), allowlist: AL })).targets, [5, 6, 7]);
  assert.deepEqual((await targetsFromEvent({ name: "workflow_dispatch", payload: { inputs: { pr: "6" } }, gh: world(), allowlist: AL })).targets, [6]);
});
test("#180 S4 closed / fork / off-allowlist / unrelated-root PRs are never targets; dedupe + sorted", async () => {
  const pulls = [pr(5, 1), pr(6, 2, { state: "closed" }), pr(7, 3, { head: { sha: "7".repeat(40), repo: { full_name: "x/fork" } } }), pr(9, 1, { base: { ref: "main", repo: { full_name: "o/r" } } }), pr(10, 1), pr(10, 1), pr(8, 50)];
  const r = await targetsFromEvent({ ...ev("issue_comment", 1), gh: world({ pulls }), allowlist: AL });
  assert.deepEqual(r.targets, [5, 10]);
});
test("#180 S5 fail closed with concrete diagnostics: non-array, partial/API failure, ambiguous, not-self-marked, 403 — never silent no_linked_open_pr", async () => {
  const bad = [
    [{ listPulls: () => ({}) }, /pr_enumeration_failed/],
    [{ listPulls: () => { throw new Error("pagination bound exceeded"); } }, /pr_enumeration_failed/],
    [{ getIssueFail: 1 }, /403/],
    [{ issues: { 1: iss(1, 1, { body: `${mark(1)}${mark(2)}` }) } }, /root_request_ambiguous/],
    [{ issues: { 1: iss(1, 9), 9: iss(9, 7) } }, /root_not_self_marked/],
  ];
  for (const [o, re] of bad) {
    const r = await targetsFromEvent({ ...ev("issue_comment", 1), gh: world(o), allowlist: AL });
    assert.match(r.error ?? "", re, JSON.stringify(o)); assert.equal(r.skip, undefined);
  }
  // a PR event still refreshes the event PR itself so its own status reflects the failure
  const r = await targetsFromEvent({ ...ev("issue_comment", 5, true), gh: world({ listPulls: () => ({}) }), allowlist: AL });
  assert.deepEqual(r.targets, [5]); assert.ok(r.error);
});
test("#180 S5b issue without any root marker is explicitly UNRELATED (not an error); a sibling with unresolvable lineage is diagnosed AND targeted (#182: never left with a stale success)", async () => {
  const a = await targetsFromEvent({ ...ev("issue_comment", 60), gh: world(), allowlist: AL });
  assert.deepEqual([a.targets, a.skip, a.error], [[], "unrelated_no_root_marker", undefined]);
  const b = await targetsFromEvent({ ...ev("issue_comment", 1), gh: world({ pulls: [pr(5, 1), pr(11, 60)] }), allowlist: AL });
  assert.deepEqual(b.targets, [5, 11]); assert.deepEqual(b.diagnostics, [{ pr: 11, unattributable: "root_marker_missing" }]);
});
test("#180 handleEvent fan-out exercises refreshPr for every target and never publishes for out-of-scope PRs", async () => {
  const calls = [];
  const gh = world({ pulls: [pr(5, 1), pr(6, 2)] });
  const check = async ({ prNumber, stage, publish }) => { calls.push(`${prNumber}:${stage}:${publish}`); return { status: "pass", head: "x", published: true, unmet: [] }; };
  const r = await handleEvent({ ...ev("issue_comment", 1), gh, allowlist: AL, check, lock: createPrLock() });
  assert.deepEqual(calls.sort(), ["5:final:true", "5:pre-pr:true", "6:final:true", "6:pre-pr:true"]);
  assert.equal(r.results.length, 4);
  const e = await handleEvent({ ...ev("issue_comment", 1), gh: world({ listPulls: () => ({}) }), allowlist: AL, check, lock: createPrLock() });
  assert.ok(e.error);
});

// ---- lock + real runCheck race ----
const HEAD = "5".repeat(40);
const gateItem = (name, a, user = OWNER, at = T(0)) => ({ user, created_at: at, updated_at: at, body: `<!-- gate:${name}:v1 ${a} -->` });
const cm = (id, o) => ({ id, created_at: T(1), updated_at: T(1), ...o });
const receipts = () => [cm(1, gateItem("pm-scope", "issue=1")), cm(2, gateItem("dev-analysis", "issue=1", DEV, T(1))), cm(3, gateItem("self-test", `issue=1 sha=${HEAD} typecheck=pass test=pass build=pass`))];
function fakeGh({ onStatus, perm } = {}) {
  const w = { comments: receipts(), statuses: [], starts: 0, perm };
  return {
    w,
    getPull: async () => { w.starts++; return { number: 5, state: "open", user: DEV, head: { sha: HEAD, repo: { full_name: "o/r" } }, base: { ref: BR, repo: { full_name: "o/r" } }, body: "Closes #1\n<!-- orch-supersedes:v1 none -->", created_at: T(2), updated_at: T(2) }; },
    getIssue: async (n) => ({ number: n, user: OWNER, body: mark(1), created_at: T(0), updated_at: T(0) }),
    listPullCommits: async () => [{ commit: { committer: { date: T(2) } } }],
    listIssueComments: async (n) => (n === 1 ? w.comments : []),
    listIssues: async () => [], listPulls: async () => [],
    createCommitStatus: async (sha, s) => { if (w.perm) throw new Error("GitHub POST 403"); await onStatus?.(s, w); w.statuses.push({ sha, ...s }); },
  };
}
const last = (w, ctx) => w.statuses.filter((s) => s.context === ctx).at(-1)?.state;
const tick = () => new Promise((r) => setTimeout(r, 15));
function pauseFirstSuccess() {
  let release; const gate = new Promise((r) => { release = r; }); let hit; const reached = new Promise((r) => { hit = r; }); let done = false;
  return { release, reached, onStatus: async (s) => { if (s.state === "success" && !done) { done = true; hit(); await gate; } } };
}

test("#180 S7 WITHOUT a shared lock the read->write pause DOES yield a stale success (race demonstrated)", async () => {
  const p = pauseFirstSuccess(); const g = fakeGh({ onStatus: p.onStatus });
  const A = refreshPr({ gh: g, prNumber: 5, allowlist: AL, lock: createPrLock() }); // A holds its OWN lock: no exclusion with B
  await p.reached;                                       // A validated + re-read, paused just before writing success
  g.w.comments = g.w.comments.filter((c) => c.id !== 3);   // receipt removed
  await refreshPr({ gh: g, prNumber: 5, allowlist: AL, lock: createPrLock() }); // B: failure
  assert.equal(last(g.w, "quality-gate/pre-pr"), "failure");
  p.release(); await A;
  assert.equal(last(g.w, "quality-gate/pre-pr"), "success", "stale A overwrote B -> the exact bug the lock must prevent");
});
test("#180 S7/S8 WITH the shared per-PR lock: B waits for A, A's write cannot outlive B; final is never success after receipt removal", async () => {
  const lock = createPrLock(); const p = pauseFirstSuccess(); const g = fakeGh({ onStatus: p.onStatus });
  const A = refreshPr({ gh: g, prNumber: 5, allowlist: AL, lock });
  await p.reached;
  g.w.comments = g.w.comments.filter((c) => c.id !== 3);
  const before = g.w.starts;
  const B = refreshPr({ gh: g, prNumber: 5, allowlist: AL, lock });
  await tick(); assert.equal(g.w.starts, before, "B must not start (no read, no write) while A holds the PR lock");
  p.release(); await Promise.all([A, B]);
  for (const ctx of ["quality-gate/pre-pr", "quality-gate/final"]) assert.notEqual(last(g.w, ctx), "success", ctx);
  assert.equal(last(g.w, "quality-gate/pre-pr"), "failure");
});
test("#180 S8 queued runs: three overlapping events all serialize FIFO and the last one reflects the latest evidence (out-of-order safe)", async () => {
  const lock = createPrLock(); const g = fakeGh(); const order = [];
  const run = (i) => lock.run(LOCK_GROUP(5), async () => { order.push(`s${i}`); await refreshPr({ gh: g, prNumber: 5, allowlist: AL, lock: createPrLock() }); order.push(`e${i}`); });
  const rs = [run(1), run(2), run(3)]; g.w.comments = g.w.comments.filter((c) => c.id !== 3); await Promise.all(rs);
  assert.deepEqual(order, ["s1", "e1", "s2", "e2", "s3", "e3"]);
  assert.equal(last(g.w, "quality-gate/pre-pr"), "failure");
});
test("#180 S11 different PRs are independent; S10 failed holder / 403 write error does not wedge the lock and recovers", async () => {
  const lock = createPrLock(); const trace = []; let rel; const hold = new Promise((r) => { rel = r; });
  const a = lock.run(LOCK_GROUP(5), async () => { trace.push("a-start"); await hold; trace.push("a-end"); });
  const b = lock.run(LOCK_GROUP(6), async () => { trace.push("b"); });
  await b; assert.deepEqual(trace, ["a-start", "b"]); rel(); await a;
  await assert.rejects(lock.run("k", async () => { throw new Error("boom"); }));
  assert.equal(await lock.run("k", async () => "ok"), "ok");
  await tick(); assert.equal(lock.pending(), 0);
  const g = fakeGh({ perm: true });
  const res = await refreshPr({ gh: g, prNumber: 5, allowlist: AL, lock });
  assert.ok(res.every((r) => r.status === "blocked" && !r.published), JSON.stringify(res));
  g.w.perm = false;
  assert.equal((await refreshPr({ gh: g, prNumber: 5, allowlist: AL, lock }))[0].status, "pass");
});
test("#180 S9 same-SHA evidence change vs moved HEAD: no green for a moved head", async () => {
  const g = fakeGh(); const orig = g.getPull; let n = 0;
  g.getPull = async (...a) => { const p = await orig(...a); return ++n >= 3 ? { ...p, head: { ...p.head, sha: "6".repeat(40) } } : p; };
  const res = await refreshPr({ gh: g, prNumber: 5, allowlist: AL, lock: createPrLock() });
  assert.ok(res.every((r) => r.status !== "pass"), JSON.stringify(res));
  assert.ok(!g.w.statuses.some((s) => s.state === "success"));
});
test("#180 S12/S13 evidence changed (root receipt removed) while a PR is processing invalidates; restore recovers; real runCheck path", async () => {
  const g = fakeGh({ onStatus: async () => {} }); let n = 0; const orig = g.listIssueComments;
  g.listIssueComments = async (i) => { const r = await orig(i); if (i === 1 && ++n === 2) g.w.comments = g.w.comments.filter((c) => c.id !== 3); return r; }; // changes between collect and re-read
  const r = await runCheck({ gh: g, prNumber: 5, stage: "pre-pr", publish: true });
  assert.notEqual(r.status, "pass"); assert.ok(!g.w.statuses.some((s) => s.state === "success"));
  g.w.comments = receipts();
  assert.equal((await runCheck({ gh: g, prNumber: 5, stage: "pre-pr", publish: true })).status, "pass");
});

// ---- structural: ONE writer domain across workflow files ----
test("#180 both workflows publish only through a per-PR job whose concurrency group is quality-gate-pr-<N>; no workflow-level group left", () => {
  for (const f of ["quality-gate.yml", "quality-gate-events.yml"]) {
    const y = readFileSync(new URL(`../../.github/workflows/${f}`, import.meta.url), "utf8");
    assert.match(y, /group: quality-gate-pr-\$\{\{ matrix\.pr \}\}/, f);
    assert.match(y, /QUALITY_GATE_PR_LOCK: quality-gate-pr-\$\{\{ matrix\.pr \}\}/, f);
    assert.doesNotMatch(y, /^concurrency:/m, f);
    assert.doesNotMatch(y, /check\.mjs/, `${f}: direct unlocked check.mjs publish`);
    assert.doesNotMatch(y, /event\.pull_request\.head|github\.head_ref/, f);
  }
  assert.equal(LOCK_GROUP(7), "quality-gate-pr-7");
});
