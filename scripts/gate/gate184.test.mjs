// Issue #184 — (A) lost-root sibling invalidation through the REAL router -> plan -> refresh -> runCheck entrypoints, (B) ONE shared
// round-ceiling authority across resolver / planner / runLifecycle. Fake GitHub API only: NOT a real GitHub E2E.
import test from "node:test";
import assert from "node:assert/strict";
import { targetsFromEvent, handleEvent } from "./event-route.mjs";
import { createPrLock } from "./pr-lock.mjs";
import * as policy from "../handoff/correction-policy.mjs";
import * as rc from "../handoff/root-corrections.mjs";
import * as lc from "../handoff/lifecycle.mjs";
import { runLifecycle } from "../handoff/lifecycle-run.mjs";

const OWNER = { login: "jonghee1998", id: 129052128, type: "User" };
const MAL = { login: "mallory", id: 6, type: "User" };
const BR = "codex/issue-92-mobile-v2", AL = [BR];
const T0 = "2026-11-18T00:00:00Z";
const iss = (number, root, o = {}) => ({ number, user: OWNER, body: root ? `<!-- orch-root-request:v1 #${root} -->\nRCA` : "plain RCA", created_at: T0, updated_at: T0, ...o });
const sha = (n) => String(n % 10).repeat(40);
const pr = (number, linked, o = {}) => ({ number, state: "open", user: OWNER, head: { sha: sha(number), repo: { full_name: "o/r" } }, base: { ref: BR, repo: { full_name: "o/r" } }, body: `Closes #${linked}`, created_at: T0, updated_at: T0, ...o });
const ev = (name, number, isPr = false) => ({ name, payload: name === "pull_request_target" ? { pull_request: { number } } : { issue: { number, ...(isPr ? { pull_request: {} } : {}) } } });

// root 1 (self-marked); revision issues 2 and 3 are root-1 siblings; issue 50 is an unrelated root. PR5->#2 (edited revision issue),
// PR6->#3 (sibling), PR8->#50 (unrelated root).
function world(o = {}) {
  const issues = { 1: iss(1, 1), 2: iss(2, 1), 3: iss(3, 1), 50: iss(50, 50), ...o.issues };
  const pulls = o.pulls ?? [pr(5, 2, { body: "Closes #2\n<!-- orch-root-request:v1 #1 -->" }), pr(6, 3), pr(8, 50)];
  const statuses = []; // ledger seeded with GREEN for every PR/context (previous success)
  for (const p of pulls) for (const c of ["quality-gate/pre-pr", "quality-gate/final"]) statuses.push({ sha: p.head.sha, context: c, state: "success" });
  return {
    statuses,
    getIssue: async (n) => { if (o.gone?.includes(n)) throw new Error(`GitHub GET /issues/${n} -> 404`); return issues[n] ?? { number: n, user: OWNER, body: "plain" }; },
    getPull: async (n) => pulls.find((p) => p.number === n) ?? pr(n, 1),
    listPulls: async () => { if (o.listPulls) return o.listPulls(); return pulls; },
    listIssueComments: async () => [], listIssues: async () => [], listPullCommits: async () => [],
    createCommitStatus: async (s, st) => { statuses.push({ sha: s, context: st.context, state: st.state }); },
  };
}
const last = (g, prNo, ctx, pulls) => g.statuses.filter((s) => s.sha === sha(prNo) && s.context === ctx).at(-1)?.state;
const lostGreen = (g, prs) => prs.every((p) => ["quality-gate/pre-pr", "quality-gate/final"].every((c) => last(g, p, c) !== "success" && last(g, p, c) !== undefined));
const keptGreen = (g, prs) => prs.every((p) => ["quality-gate/pre-pr", "quality-gate/final"].every((c) => last(g, p, c) === "success"));
const run = (g, e) => handleEvent({ ...e, gh: g, allowlist: AL, lock: createPrLock() });

test("#184-A1 marker REMOVED from edited revision issue (linked PR keeps verified marker): BOTH sibling PRs lose their previous green; unrelated root keeps it", async () => {
  const g = world({ issues: { 2: iss(2, 0) } });
  const out = await run(g, ev("issues", 2));
  assert.deepEqual(out.targets, [5, 6]); assert.equal(out.error, undefined);
  assert.ok(lostGreen(g, [5, 6]), JSON.stringify(g.statuses.slice(-8))); assert.ok(keptGreen(g, [8]));
});
test("#184-A2 marker removed AND no verified historical link => superset: both siblings (and every eligible PR) lose green; explicit root_marker_lost", async () => {
  const g = world({ issues: { 2: iss(2, 0) }, pulls: [pr(5, 2), pr(6, 3), pr(8, 50)] });
  const out = await run(g, ev("issue_comment", 2));
  assert.deepEqual(out.targets, [5, 6, 8]); assert.match(out.error, /root_marker_lost/);
  assert.ok(lostGreen(g, [5, 6, 8]));
});
test("#184-A3 no directly linked PR / root-only issue / unmarked issue: never silently UNRELATED", async () => {
  const none = await targetsFromEvent({ ...ev("issues", 2), gh: world({ issues: { 2: iss(2, 0) }, pulls: [pr(6, 3), pr(8, 50)] }), allowlist: AL });
  assert.deepEqual(none.targets, [6, 8]); assert.match(none.error, /root_marker_lost/);
  const unmarked = await targetsFromEvent({ ...ev("issue_comment", 99), gh: world(), allowlist: AL });
  assert.deepEqual(unmarked.targets, [5, 6, 8]);
  const rootOnly = await targetsFromEvent({ ...ev("issue_comment", 1), gh: world(), allowlist: AL });
  assert.deepEqual(rootOnly.targets, [5, 6]); assert.equal(rootOnly.error, undefined);
});
test("#184-A4 restoration: marker present again => normal root routing, no error; verifiably OTHER root stays unrelated", async () => {
  const r = await targetsFromEvent({ ...ev("issues", 2), gh: world(), allowlist: AL });
  assert.deepEqual([r.targets, r.error], [[5, 6], undefined]);
  const other = await targetsFromEvent({ ...ev("issue_comment", 50), gh: world(), allowlist: AL });
  assert.deepEqual(other.targets, [8]);
});
test("#184-A5 verified historical root followed; ambiguous / untrusted-author historical marker => superset", async () => {
  const wrongRoot = world({ issues: { 2: iss(2, 0) }, pulls: [pr(5, 2, { body: "Closes #2\n<!-- orch-root-request:v1 #50 -->" }), pr(6, 3), pr(8, 50)] });
  // trusted-PM PR marker naming a verified (self-marked) root is the independently verified historical link; it is followed, root 50 siblings refresh
  assert.deepEqual((await targetsFromEvent({ ...ev("issues", 2), gh: wrongRoot, allowlist: AL })).targets, [5, 8]);
  const amb = world({ issues: { 2: iss(2, 0) }, pulls: [pr(5, 2, { body: "Closes #2\n<!-- orch-root-request:v1 #1 -->\n<!-- orch-root-request:v1 #50 -->" }), pr(6, 3), pr(8, 50)] });
  const r = await targetsFromEvent({ ...ev("issues", 2), gh: amb, allowlist: AL });
  assert.deepEqual(r.targets, [5, 6, 8]); assert.match(r.error, /root_marker_lost/);
  const forged = world({ issues: { 2: iss(2, 0) }, pulls: [pr(5, 2, { body: "Closes #2\n<!-- orch-root-request:v1 #1 -->", user: MAL }), pr(6, 3), pr(8, 50)] });
  assert.deepEqual((await targetsFromEvent({ ...ev("issues", 2), gh: forged, allowlist: AL })).targets, [5, 6, 8]);
});
test("#184-A6 deleted issue (404) and PR event whose linked issue lost its marker => superset; partial enumeration => BLOCKED+stale", async () => {
  assert.deepEqual((await targetsFromEvent({ ...ev("issues", 2), gh: world({ gone: [2] }), allowlist: AL })).targets, [5, 6, 8]);
  const prEv = await targetsFromEvent({ ...ev("pull_request_target", 6), gh: world({ issues: { 3: iss(3, 0) } }), allowlist: AL });
  assert.deepEqual(prEv.targets, [5, 6, 8]); assert.match(prEv.error, /root_marker_lost/);
  const blocked = await targetsFromEvent({ ...ev("issues", 2), gh: world({ issues: { 2: iss(2, 0) }, listPulls: () => { throw new Error("502"); } }), allowlist: AL });
  assert.deepEqual([blocked.blocked, blocked.error], [true, "pr_enumeration_failed"]); assert.match(blocked.stale, /may remain stale/);
});
test("#184-A7 event trace: handleEvent reports targets and statuses; nothing writes success", async () => {
  const g = world({ issues: { 2: iss(2, 0) } }); const lines = [];
  const out = await handleEvent({ ...ev("issues", 2), gh: g, allowlist: AL, lock: createPrLock(), out: (o) => lines.push(o) });
  assert.deepEqual(out.targets, [5, 6]); assert.ok(lines.length >= 4 && lines.every((l) => l.status !== "pass")); assert.ok(g.statuses.every((s, i) => i < 6 || s.state !== "success"));
});

// ---------- B. one ceiling authority ----------
test("#184-B1 resolver, planner and lifecycle share ONE policy object (no duplicate constants)", () => {
  assert.equal(rc.ceilingFor, policy.ceilingFor); assert.equal(rc.ROOT_CEILING_EXCEPTIONS, policy.ROOT_CEILING_EXCEPTIONS);
  assert.equal(lc.MAX_ROUNDS_ROOT_EXCEPTIONS, policy.ROOT_CEILING_EXCEPTIONS); assert.equal(lc.MAX_ROUNDS_CEILING, policy.CORRECTION_CEILING);
  assert.deepEqual({ ...policy.ROOT_CEILING_EXCEPTIONS }, { 146: 14 });
});
test("#184-B2 every supported bound agrees across resolver and planner; unsupported/low/other-root rejected by both", () => {
  const T = (b) => ({ user: OWNER, created_at: T0, updated_at: T0, body: b });
  const lim = (root, max) => rc.resolveCorrectionLimit([T(`<!-- orch-root-correction-limit:v1 root${root} max=${max} -->`)], root);
  const plan = (req, maxRounds) => lc.planLifecycle({ req, round: 1, maxRounds, config: lc.parseConfig({ allowlist: [BR], expectedBase: "c".repeat(40) }), integrationTarget: BR, pr: null, reviews: [], pmAccepts: [], pmRevises: [], records: [] }).reason;
  for (const [root, max, ok] of [[146, 3, true], [146, 12, true], [146, 13, true], [146, 14, true], [146, 15, false], [146, 2, false], [136, 5, true], [136, 6, false], [147, 14, false]]) {
    const a = !lim(root, max).error, b = plan(root, max) !== "invalid_round_limit";
    assert.equal(a, ok, `resolver ${root}/${max}`); assert.equal(b, ok, `planner ${root}/${max}`);
  }
});
test("#184-B3 runLifecycle root146 with n1..n12 + max=13: no invalid_round_limit / limit contradiction; consumed records preserved", async () => {
  const sha40 = (n) => String(n).padStart(2, "0").repeat(20);
  const marks = Array.from({ length: 12 }, (_, i) => ({ id: 100 + i, user: OWNER, created_at: T0, updated_at: T0, body: rc.correctionMarker({ root: 146, n: i + 1, pr: 300 + i, sha: sha40(i + 1) }) }));
  const limit = { id: 99, user: OWNER, created_at: T0, updated_at: T0, body: "<!-- orch-root-correction-limit:v1 root146 max=13 -->" };
  const P = { number: 400, state: "open", merged: false, user: OWNER, head: { ref: "claude/x", sha: "e".repeat(40) }, base: { ref: BR, sha: "c".repeat(40) }, body: "Refs #146\n<!-- orch-supersedes:v1 none -->" };
  const gh = {
    getPull: async () => P, getIssue: async (n) => (n === 146 ? iss(146, 146) : iss(n, 146)), listIssueComments: async (n) => (n === 146 ? [limit, ...marks] : []),
    listIssues: async () => [], listPulls: async () => [], getCommit: async () => ({}), getBranch: async () => ({}), compare: async () => ({}), listCheckRuns: async () => [], getCombinedStatus: async () => ({ statuses: [] }),
  };
  const r = await runLifecycle(gh, 400, { config: lc.parseConfig({ allowlist: [BR], expectedBase: "c".repeat(40) }), expectedHead: "e".repeat(40) });
  assert.notEqual(r.reason, "invalid_round_limit", JSON.stringify(r));
  assert.ok(!/correction_limit|n_out_of_range/.test(r.reason ?? ""), JSON.stringify(r));
  assert.notEqual(r.action, "merge"); // no review / security evidence: still not a pass
  // exceeding the authorized bound is rejected
  const over = { ...limit, body: limit.body.replace("max=13", "max=15") };
  const r2 = await runLifecycle({ ...gh, listIssueComments: async (n) => (n === 146 ? [over, ...marks] : []) }, 400, { config: lc.parseConfig({ allowlist: [BR], expectedBase: "c".repeat(40) }), expectedHead: "e".repeat(40) });
  assert.equal(r2.reason, "correction_limit_out_of_range");
});
