// Issue #192 (correction n16, root 146) — composed link x marker x payload x history transitions through the REAL handleEvent ->
// targetsFromEvent -> refreshPr -> runCheck entrypoints, plus both-context invalidation ORDER. Fake GitHub API only: NOT a real GitHub E2E
// (the issues/issue_comment workflows are inert off the default branch; required ruleset / live A-F E2E remain unproven).
import test from "node:test";
import assert from "node:assert/strict";
import { targetsFromEvent, handleEvent, refreshPr } from "./event-route.mjs";
import { createPrLock } from "./pr-lock.mjs";

const OWNER = { login: "jonghee1998", id: 129052128, type: "User" };
const MAL = { login: "mallory", id: 6, type: "User" };
const BR = "codex/issue-92-mobile-v2", AL = [BR];
const T0 = "2026-11-18T00:00:00Z";
const M = (r) => `<!-- orch-root-request:v1 #${r} -->`;
const iss = (number, root, o = {}) => ({ number, user: OWNER, body: root ? `${M(root)}\nRCA` : "plain", created_at: T0, updated_at: T0, ...o });
const sha = (n) => String(n % 10).repeat(40);
const pr = (number, linked, root, o = {}) => ({ number, state: "open", user: OWNER, head: { sha: sha(number), repo: { full_name: "o/r" } }, base: { ref: BR, repo: { full_name: "o/r" } }, body: `${linked ? `Closes #${linked}` : "no link"}\n${root ? M(root) : ""}`, created_at: T0, updated_at: T0, ...o });
const CTX = ["quality-gate/pre-pr", "quality-gate/final"];
// root A=1 (issues 1,2,3; PR5->#2, PR6->#3), root B=50 (issues 50,51,52; PR8->#51, PR9->#52); every PR/context previously GREEN.
function world(o = {}) {
  const issues = { 1: iss(1, 1), 2: iss(2, 1), 3: iss(3, 1), 50: iss(50, 50), 51: iss(51, 50), 52: iss(52, 50), 60: iss(60, 0), ...o.issues };
  const pulls = o.pulls ?? [pr(5, 2, 1), pr(6, 3, 1), pr(8, 51, 50), pr(9, 52, 50)];
  const statuses = [], reads = [];
  for (const p of pulls) for (const c of CTX) statuses.push({ sha: p.head.sha, context: c, state: "success" });
  const seed = statuses.length;
  const spy = (name, fn) => async (...a) => { reads.push({ name, at: statuses.length }); return fn(...a); };
  return {
    statuses, reads, seed, issues, pulls,
    getIssue: spy("getIssue", async (n) => { if (o.gone?.includes(n)) throw new Error("404"); return issues[n] ?? { number: n, user: OWNER, body: "plain" }; }),
    getPull: async (n) => { const p = pulls.find((x) => x.number === n) ?? pr(n, 1, 1); return o.onGetPull ? o.onGetPull(p, n) : p; },
    listPulls: async () => { if (o.listPulls) return o.listPulls(); return pulls; },
    listIssueComments: spy("listIssueComments", async () => []), listIssues: spy("listIssues", async () => Object.values(issues)), listPullCommits: spy("listPullCommits", async () => []),
    createCommitStatus: async (s, st) => { if (o.failWrite?.(s, st)) throw new Error("GitHub POST 502"); statuses.push({ sha: s, context: st.context, state: st.state }); },
  };
}
const last = (g, n, c) => g.statuses.filter((s) => s.sha === sha(n) && s.context === c).at(-1)?.state;
const lostGreen = (g, ns) => ns.every((n) => CTX.every((c) => last(g, n, c) !== undefined && last(g, n, c) !== "success"));
const keptGreen = (g, ns) => ns.every((n) => CTX.every((c) => last(g, n, c) === "success"));
const prEdit = (n, from) => ({ name: "pull_request_target", payload: { action: "edited", ...(from === undefined ? {} : { changes: { body: { from } } }), pull_request: { number: n } } });
const issEdit = (n, from, action = "edited") => ({ name: "issues", payload: { action, ...(from === undefined ? {} : { changes: { body: { from } } }), issue: { number: n } } });
const comment = (n) => ({ name: "issue_comment", payload: { action: "created", issue: { number: n } } });
const run = (g, e) => handleEvent({ ...e, gh: g, allowlist: AL, lock: createPrLock() });
const PRIOR = `Closes #2\n${M(1)}`; // PR5 body before the edit: linked to #2, marker root A

test("#192-S1 link A->B AND marker deleted at once, payload prior present: A siblings (PR6) are refreshed and lose green; real write path", async () => {
  const g = world({ pulls: [pr(5, 51, 0), pr(6, 3, 1), pr(8, 51, 50), pr(9, 52, 50)] });
  const out = await run(g, prEdit(5, PRIOR));
  assert.deepEqual(out.targets, [5, 6, 8, 9], JSON.stringify(out)); assert.equal(out.error, undefined);
  assert.ok(lostGreen(g, [5, 6, 8, 9])); assert.equal(out.results.length, 8);
  assert.equal(g.statuses.slice(g.seed).filter((s) => s.state === "success").length, 0, "no new success written");
});
test("#192-S2 same composed edit but NO payload prior: old link unknowable => superset + explicit error, never B-only", async () => {
  const g = world({ pulls: [pr(5, 51, 0), pr(6, 3, 1), pr(7, 2, 1), pr(8, 51, 50), pr(9, 52, 50)] });
  const out = await run(g, prEdit(5, undefined));
  assert.deepEqual(out.targets, [5, 6, 7, 8, 9]); assert.equal(out.error, "root_marker_lost"); assert.ok(lostGreen(g, [5, 6, 7, 8, 9]));
});
test("#192-S3 control: link A->B + marker B (both valid) => A and B siblings", async () => {
  const r = await targetsFromEvent({ ...prEdit(5, PRIOR), gh: world({ pulls: [pr(5, 51, 50), pr(6, 3, 1), pr(8, 51, 50), pr(9, 52, 50)] }), allowlist: AL });
  assert.deepEqual([r.targets, r.error], [[5, 6, 8, 9], undefined]);
});
test("#192-S4 link A->B with marker A kept (conflict), link removed + marker deleted, two link refs: superset + error", async () => {
  const conflict = await targetsFromEvent({ ...prEdit(5, PRIOR), gh: world({ pulls: [pr(5, 51, 1), pr(6, 3, 1), pr(8, 51, 50), pr(9, 52, 50)] }), allowlist: AL });
  assert.deepEqual(conflict.targets, [5, 6, 8, 9]); assert.equal(conflict.error, "root_marker_conflict");
  const nolink = await targetsFromEvent({ ...prEdit(5, PRIOR), gh: world({ pulls: [pr(5, 0, 0), pr(6, 3, 1), pr(8, 51, 50), pr(9, 52, 50)] }), allowlist: AL });
  assert.deepEqual(nolink.targets, [5, 6, 8, 9]); assert.equal(nolink.error, "root_marker_lost");
  const two = await targetsFromEvent({ ...prEdit(5, PRIOR), gh: world({ pulls: [pr(5, 51, 0, { body: "Closes #51\nCloses #52" }), pr(6, 3, 1), pr(8, 51, 50), pr(9, 52, 50)] }), allowlist: AL });
  assert.deepEqual(two.targets, [5, 6, 8, 9]); assert.ok(two.error);
});
test("#192-S5 ambiguous / duplicated / forged / non-root prior or current marker => superset + error", async () => {
  const base = { pulls: [pr(5, 51, 0), pr(6, 3, 1), pr(8, 51, 50), pr(9, 52, 50)] };
  const amb = await targetsFromEvent({ ...prEdit(5, `Closes #2\n${M(1)}${M(50)}`), gh: world(base), allowlist: AL });
  assert.deepEqual(amb.targets, [5, 6, 8, 9]); assert.match(amb.error, /previous_root_ambiguous/);
  const nonroot = await targetsFromEvent({ ...prEdit(5, `Closes #2\n${M(77)}`), gh: world(base), allowlist: AL });
  assert.deepEqual(nonroot.targets, [5, 6, 8, 9]); assert.match(nonroot.error, /previous_root_unverifiable/);
  const dupNow = await targetsFromEvent({ ...prEdit(5, PRIOR), gh: world({ pulls: [pr(5, 51, 0, { body: `Closes #51\n${M(1)}${M(50)}` }), pr(6, 3, 1), pr(8, 51, 50), pr(9, 52, 50)] }), allowlist: AL });
  assert.deepEqual(dupNow.targets, [5, 6, 8, 9]); assert.equal(dupNow.error, "root_request_ambiguous");
  // forged prior: the PR is owned by a NON-trusted user, so its prior marker is not a candidate and, with no prior link either, nothing independent proves A
  const forged = await targetsFromEvent({ ...prEdit(5, M(1)), gh: world({ pulls: [pr(5, 51, 0, { user: MAL }), pr(6, 3, 1), pr(8, 51, 50), pr(9, 52, 50)] }), allowlist: AL });
  assert.deepEqual(forged.targets, [5, 6, 8, 9]); assert.equal(forged.error, "previous_root_unprovable");
  // current-link history (siblings of the NEW link) must never be mistaken for proof of the FORMER root
  assert.ok(forged.diagnostics.filter((d) => d.formerRoot === 50).every((d) => d.counted === false));
});
test("#192-S6 prior link history alone (no payload marker) and a CLOSED historical source PR are anchors: A recovered from ALL-state history", async () => {
  const closed = pr(10, 2, 1, { state: "closed" });
  const r = await targetsFromEvent({ ...prEdit(5, "Closes #2"), gh: world({ pulls: [pr(5, 51, 0), closed, pr(6, 3, 1), pr(8, 51, 50), pr(9, 52, 50)] }), allowlist: AL });
  assert.deepEqual([r.targets, r.error], [[5, 6, 8, 9], undefined], JSON.stringify(r)); // PR10 is closed: not a target, but it PROVED root A
  // the prior link names an issue (#60) that is not in any root and no PR history exists for it => former root unprovable => superset
  const noAnchor = await targetsFromEvent({ ...prEdit(5, "Closes #60"), gh: world({ pulls: [pr(5, 51, 0), pr(6, 3, 1), pr(8, 51, 50), pr(9, 52, 50)] }), allowlist: AL });
  assert.deepEqual(noAnchor.targets, [5, 6, 8, 9]); assert.match(noAnchor.error, /previous_root_unverifiable/);
});
test("#192-S7 issue marker deleted with payload prior A: A siblings refreshed (payload is only a candidate, re-verified live); no prior => history, conflict => superset", async () => {
  const g = world({ issues: { 2: iss(2, 0) } });
  const out = await run(g, issEdit(2, `${M(1)}\nRCA`));
  assert.deepEqual([out.targets, out.error], [[5, 6], undefined]); assert.ok(lostGreen(g, [5, 6])); assert.ok(keptGreen(g, [8, 9]));
  const hist = await targetsFromEvent({ ...issEdit(2, undefined), gh: world({ issues: { 2: iss(2, 0) } }), allowlist: AL });
  assert.deepEqual([hist.targets, hist.error], [[5, 6], undefined]);
  const conflict = await targetsFromEvent({ ...issEdit(2, undefined), gh: world({ issues: { 2: iss(2, 0) }, pulls: [pr(5, 2, 1), pr(7, 2, 50), pr(6, 3, 1), pr(8, 51, 50)] }), allowlist: AL });
  assert.equal(conflict.error, "root_marker_lost"); assert.deepEqual(conflict.targets, [5, 6, 7, 8]);
});
test("#192-S8 anchor-less unmarked issue comment / opened is explicit skip (no red noise); an anchoring PR, or a MOVING event, keeps the conservative path", async () => {
  for (const e of [comment(60), { name: "issues", payload: { action: "opened", issue: { number: 60 } } }]) {
    const r = await targetsFromEvent({ ...e, gh: world(), allowlist: AL });
    assert.deepEqual([r.targets, r.skip, r.error, r.superset], [[], "unrelated_no_root_marker", undefined, undefined]);
  }
  const linked = await targetsFromEvent({ ...comment(60), gh: world({ pulls: [pr(5, 60, 0), pr(6, 3, 1), pr(8, 51, 50)] }), allowlist: AL });
  assert.equal(linked.error, "root_marker_lost"); assert.deepEqual(linked.targets, [5, 6, 8]);
  const closedAnchor = await targetsFromEvent({ ...comment(60), gh: world({ pulls: [pr(5, 60, 0, { state: "closed" }), pr(6, 3, 1), pr(8, 51, 50)] }), allowlist: AL });
  assert.equal(closedAnchor.error, "root_marker_lost", "a CLOSED PR linked to the issue is still an anchor");
  const moving = await targetsFromEvent({ ...issEdit(60, undefined), gh: world(), allowlist: AL }); // edited, no payload prior, no anchor: cannot be proven unrelated
  assert.equal(moving.error, "root_marker_lost"); assert.deepEqual(moving.targets, [5, 6, 8, 9]);
});
test("#192-S9 enumeration / pagination failure: BLOCKED + stale note; non-array; PR event keeps only the event PR as target", async () => {
  for (const listPulls of [() => { throw new Error("502"); }, () => ({})]) {
    const b = await targetsFromEvent({ ...prEdit(5, PRIOR), gh: world({ listPulls }), allowlist: AL });
    assert.deepEqual([b.blocked, b.error, b.targets], [true, "pr_enumeration_failed", [5]]); assert.match(b.stale, /may remain stale/);
    const i = await targetsFromEvent({ ...issEdit(2, M(1)), gh: world({ listPulls }), allowlist: AL });
    assert.deepEqual([i.blocked, i.targets], [true, []]);
  }
  const unreadable = await targetsFromEvent({ ...prEdit(5, PRIOR), gh: world({ gone: [1] , pulls: [pr(5, 51, 0), pr(6, 3, 1), pr(8, 51, 50), pr(9, 52, 50)] }), allowlist: AL });
  assert.deepEqual(unreadable.targets, [5, 6, 8, 9]); assert.ok(unreadable.error);
});
test("#192-S10 BOTH contexts are invalidated before the FIRST evidence read of EITHER stage (write ORDER asserted)", async () => {
  const g = world({ pulls: [pr(5, 51, 0), pr(6, 3, 1), pr(8, 51, 50), pr(9, 52, 50)] });
  await handleEvent({ ...prEdit(5, PRIOR), gh: g, allowlist: AL, lock: createPrLock() });
  for (const n of [5, 6, 8, 9]) {
    const mine = g.statuses.map((s, i) => ({ ...s, i })).filter((s) => s.i >= g.seed && s.sha === sha(n));
    assert.deepEqual(mine.slice(0, 2).map((s) => [s.context, s.state]), CTX.map((c) => [c, "pending"]), `PR${n}: both contexts pending first`);
  }
  // refreshPr alone for ONE PR, serial: reads for that PR (getIssue/listPullCommits...) happen only after both pendings of that PR
  const g2 = world();
  await refreshPr({ gh: g2, prNumber: 5, allowlist: AL, lock: createPrLock() });
  const firstRead = g2.reads[0].at; assert.ok(firstRead >= g2.seed + 2, `first evidence read happened after ${firstRead - g2.seed} writes`);
  assert.deepEqual(g2.statuses.slice(g2.seed, g2.seed + 2).map((s) => [s.context, s.state]), CTX.map((c) => [c, "pending"]));
  assert.ok(!CTX.some((c) => last(g2, 5, c) === "success"));
});
test("#192-S11 invalidation write fails for one context: reported (invalidation_failed / published:false), that stage is not evaluated, never green", async () => {
  const g = world({ failWrite: (s, st) => s === sha(5) && st.context === "quality-gate/final" });
  const rows = await refreshPr({ gh: g, prNumber: 5, allowlist: AL, lock: createPrLock() });
  const fin = rows.find((r) => r.stage === "final");
  assert.deepEqual([fin.status, fin.published, fin.unmet], ["blocked", false, ["invalidation_failed"]]);
  assert.notEqual(last(g, 5, "quality-gate/pre-pr"), "success");
  const g2 = world({ failWrite: () => true });
  const rows2 = await refreshPr({ gh: g2, prNumber: 5, allowlist: AL, lock: createPrLock() });
  assert.ok(rows2.every((r) => r.published === false && r.status === "blocked"));
});
test("#192-S12 duplicate / out-of-order events serialize on the per-PR lock; HEAD moving mid-check never gets a green and the new head is invalidated too", async () => {
  const g = world({ pulls: [pr(5, 51, 0), pr(6, 3, 1), pr(8, 51, 50), pr(9, 52, 50)] });
  const lock = createPrLock();
  await Promise.all([handleEvent({ ...prEdit(5, PRIOR), gh: g, allowlist: AL, lock }), handleEvent({ ...prEdit(5, undefined), gh: g, allowlist: AL, lock })]);
  assert.ok(lostGreen(g, [5, 6, 8, 9])); assert.equal(g.statuses.slice(g.seed).filter((s) => s.state === "success").length, 0);
  // head moves after the first getPull of the refresh
  const NEW = "e".repeat(40); let calls = 0;
  const g3 = world({ onGetPull: (p) => (p.number === 5 && ++calls > 1 ? { ...p, head: { ...p.head, sha: NEW } } : p) });
  const rows = await refreshPr({ gh: g3, prNumber: 5, allowlist: AL, lock: createPrLock() });
  assert.ok(rows.every((r) => r.status !== "pass"));
  assert.ok(CTX.every((c) => g3.statuses.some((s) => s.sha === NEW && s.context === c && s.state === "pending")), "the NEW head had both contexts invalidated");
});
test("#192-S13 root146 bound is 16 for root146 only; every other root keeps default 3 / ceiling 5", async () => {
  const policy = await import("../handoff/correction-policy.mjs");
  assert.deepEqual({ ...policy.ROOT_CEILING_EXCEPTIONS }, { 146: 16 });
  assert.equal(policy.ceilingFor(146), 16); assert.equal(policy.ceilingFor(147), 5); assert.equal(policy.MAX_CORRECTIONS, 3);
});
