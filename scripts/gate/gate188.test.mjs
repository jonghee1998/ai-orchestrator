// Issue #188 — OLD-ROOT / NEW-ROOT dependency UNION for root-attribution transitions, through the REAL router -> plan -> refresh -> runCheck
// entrypoints (handleEvent). Fake GitHub API only: NOT a real GitHub E2E (issues/issue_comment workflows are inert off the default branch).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { targetsFromEvent, handleEvent } from "./event-route.mjs";
import { createPrLock } from "./pr-lock.mjs";

const OWNER = { login: "jonghee1998", id: 129052128, type: "User" };
const MAL = { login: "mallory", id: 6, type: "User" };
const BR = "codex/issue-92-mobile-v2", AL = [BR];
const T0 = "2026-11-18T00:00:00Z";
const M = (r) => `<!-- orch-root-request:v1 #${r} -->`;
const iss = (number, root, o = {}) => ({ number, user: OWNER, body: root ? `${M(root)}\nRCA` : "plain", created_at: T0, updated_at: T0, ...o });
const sha = (n) => String(n % 10).repeat(40);
const pr = (number, linked, root, o = {}) => ({ number, state: "open", user: OWNER, head: { sha: sha(number), repo: { full_name: "o/r" } }, base: { ref: BR, repo: { full_name: "o/r" } }, body: `Closes #${linked}\n${root ? M(root) : ""}`, created_at: T0, updated_at: T0, ...o });
const CTX = ["quality-gate/pre-pr", "quality-gate/final"];
// root A=1: issues 1,2,3 ; root B=50: issues 50,51,52. Each root has >=2 previously GREEN sibling PRs: A: PR5(->#2) PR6(->#3) ; B: PR8(->#51) PR9(->#52).
function world(o = {}) {
  const issues = { 1: iss(1, 1), 2: iss(2, 1), 3: iss(3, 1), 50: iss(50, 50), 51: iss(51, 50), 52: iss(52, 50), ...o.issues };
  const pulls = o.pulls ?? [pr(5, 2, 1), pr(6, 3, 1), pr(8, 51, 50), pr(9, 52, 50)];
  const statuses = [];
  for (const p of pulls) for (const c of CTX) statuses.push({ sha: p.head.sha, context: c, state: "success" });
  return {
    statuses, issues, pulls,
    getIssue: async (n) => { if (o.gone?.includes(n)) throw new Error("404"); return issues[n] ?? { number: n, user: OWNER, body: "plain" }; },
    getPull: async (n) => pulls.find((p) => p.number === n) ?? pr(n, 1, 1),
    listPulls: async () => { if (o.listPulls) return o.listPulls(); return pulls; },
    listIssueComments: async () => [], listIssues: async () => Object.values(issues), listPullCommits: async () => [],
    createCommitStatus: async (s, st) => { statuses.push({ sha: s, context: st.context, state: st.state }); },
  };
}
const last = (g, n, c) => g.statuses.filter((s) => s.sha === sha(n) && s.context === c).at(-1)?.state;
const lostGreen = (g, ns) => ns.every((n) => CTX.every((c) => last(g, n, c) !== undefined && last(g, n, c) !== "success"));
const keptGreen = (g, ns) => ns.every((n) => CTX.every((c) => last(g, n, c) === "success"));
const issEv = (n, from, action = "edited") => ({ name: "issues", payload: { action, ...(from === undefined ? {} : { changes: { body: { from } } }), issue: { number: n } } });
const prEv = (n, from, action = "edited") => ({ name: "pull_request_target", payload: { action, ...(from === undefined ? {} : { changes: { body: { from } } }), pull_request: { number: n } } });
const run = (g, e) => handleEvent({ ...e, gh: g, allowlist: AL, lock: createPrLock() });

test("#188-B1 issue marker validA->validB: every A AND B sibling is re-evaluated and loses its previous green (real router->refresh->runCheck)", async () => {
  const g = world({ issues: { 2: iss(2, 50) } }); // issue 2 now says root 50; PR5 (linked #2, own marker 1) was root A
  const out = await run(g, issEv(2, `${M(1)}\nRCA`));
  assert.deepEqual(out.targets, [5, 6, 8, 9], JSON.stringify(out));
  assert.equal(out.error, undefined);
  assert.ok(lostGreen(g, [5, 6, 8, 9]), JSON.stringify(g.statuses.slice(-16)));
  assert.equal(out.results.length, 8); // both stages, every target: invalidated pending then a non-green verdict
  assert.ok(g.statuses.filter((s) => s.state === "success").length === 8, "no new success written (only the seeded greens)");
});
test("#188-B2 old root never narrowed because the CURRENT root is valid: payload prior A + valid current B => A siblings included", async () => {
  const g = world({ issues: { 2: iss(2, 50) }, pulls: [pr(6, 3, 1), pr(7, 3, 1), pr(8, 51, 50), pr(9, 52, 50)] });
  const r = await targetsFromEvent({ ...issEv(2, M(1)), gh: g, allowlist: AL });
  assert.deepEqual(r.targets, [6, 7, 8, 9]);
});
test("#188-B3 NO previous field: independent history (PR linked to the issue carrying its own marker) still yields A; none => conservative superset", async () => {
  const hist = await targetsFromEvent({ ...issEv(2, undefined), gh: world({ issues: { 2: iss(2, 50) } }), allowlist: AL });
  assert.deepEqual(hist.targets, [5, 6, 8, 9]); assert.equal(hist.error, undefined);
  const none = await targetsFromEvent({ ...issEv(2, undefined), gh: world({ issues: { 2: iss(2, 50) }, pulls: [pr(5, 2, 0), pr(6, 3, 1), pr(8, 51, 50), pr(9, 52, 50)] }), allowlist: AL });
  assert.deepEqual(none.targets, [5, 6, 8, 9]); assert.equal(none.error, "previous_root_unprovable"); assert.equal(none.superset, true);
});
test("#188-B4 A->none, none->A, A->ambiguous / forged / unreadable prior => union or superset, never narrower", async () => {
  const rm = await targetsFromEvent({ ...issEv(2, M(1)), gh: world({ issues: { 2: iss(2, 0) } }), allowlist: AL });
  assert.ok([5, 6].every((n) => rm.targets.includes(n)));
  const add = await targetsFromEvent({ ...issEv(2, "plain"), gh: world({ issues: { 2: iss(2, 1) }, pulls: [pr(5, 2, 1), pr(6, 3, 1), pr(8, 51, 50)] }), allowlist: AL });
  assert.deepEqual(add.targets, [5, 6]); assert.equal(add.error, undefined);
  const amb = await targetsFromEvent({ ...issEv(2, `${M(1)}${M(50)}`), gh: world({ issues: { 2: iss(2, 50) } }), allowlist: AL });
  assert.deepEqual(amb.targets, [5, 6, 8, 9]); assert.match(amb.error, /previous_root_ambiguous/);
  const forged = await targetsFromEvent({ ...issEv(2, M(77)), gh: world({ issues: { 2: iss(2, 50) } }), allowlist: AL }); // prior root 77 is not a self-marked root
  assert.deepEqual(forged.targets, [5, 6, 8, 9]); assert.match(forged.error, /previous_root_unverifiable/);
  const unreadable = await targetsFromEvent({ ...issEv(2, M(1)), gh: world({ issues: { 2: iss(2, 50) }, gone: [1] }), allowlist: AL });
  assert.deepEqual(unreadable.targets, [5, 6, 8, 9]); assert.ok(unreadable.error);
});
test("#188-B5 A->A (RCA / receipt edit) does not widen to the unrelated root", async () => {
  const g = world();
  const out = await run(g, issEv(2, `${M(1)}\nold RCA`));
  assert.deepEqual(out.targets, [5, 6]); assert.ok(keptGreen(g, [8, 9]));
});
test("#188-B6 root issue ITSELF moves A->B (self marker replaced): siblings of both roots are targets", async () => {
  const r = await targetsFromEvent({ ...issEv(1, M(1)), gh: world({ issues: { 1: iss(1, 50) } }), allowlist: AL });
  assert.ok([5, 6].every((n) => r.targets.includes(n)), JSON.stringify(r));
  assert.ok(r.error || r.targets.includes(8));
});
test("#188-B7 PR body retarget: link L(A)->L(B) with marker B (prior from payload via PR owner) => A and B siblings", async () => {
  const g = world({ pulls: [pr(5, 51, 50), pr(6, 3, 1), pr(7, 2, 1), pr(8, 51, 50), pr(9, 52, 50)] }); // PR5 now linked #51 / marker 50, was #2 / marker 1
  const out = await run(g, prEv(5, `Closes #2\n${M(1)}`));
  assert.deepEqual(out.targets, [5, 6, 7, 8, 9]); assert.equal(out.error, undefined);
  assert.ok(lostGreen(g, [5, 6, 7, 8, 9]));
});
test("#188-B8 PR event with no previous field: history of its linked issue, else superset; opened/synchronize need no former root", async () => {
  const g = world();
  const nof = await targetsFromEvent({ ...prEv(5, undefined), gh: g, allowlist: AL });
  assert.deepEqual(nof.targets, [5, 6, 8, 9]); assert.equal(nof.error, "previous_root_unprovable"); // no other PR linked to #2 => former root unprovable => superset
  const sy = await targetsFromEvent({ ...prEv(5, undefined, "synchronize"), gh: world(), allowlist: AL });
  assert.deepEqual([sy.targets, sy.error], [[5, 6], undefined]);
});
test("#188-B9 closed historical source PR provides history; pages/API failure is BLOCKED, never safe", async () => {
  const closed = pr(10, 2, 1, { state: "closed" });
  const g = world({ issues: { 2: iss(2, 50) }, pulls: [closed, pr(6, 3, 1), pr(8, 51, 50), pr(9, 52, 50)] });
  const r = await targetsFromEvent({ ...issEv(2, undefined), gh: g, allowlist: AL });
  assert.deepEqual(r.targets, [6, 8, 9]); assert.equal(r.error, undefined);
  const blocked = await targetsFromEvent({ ...issEv(2, M(1)), gh: world({ listPulls: () => { throw new Error("502"); } }), allowlist: AL });
  assert.deepEqual([blocked.blocked, blocked.error], [true, "pr_enumeration_failed"]); assert.match(blocked.stale, /may remain stale/);
});
test("#188-B10 restoration B->A, duplicate / out-of-order events: serialized, no green after a transition event", async () => {
  const g = world({ issues: { 2: iss(2, 50) } });
  const lock = createPrLock();
  await Promise.all([handleEvent({ ...issEv(2, M(1)), gh: g, allowlist: AL, lock }), handleEvent({ ...issEv(2, M(1)), gh: g, allowlist: AL, lock })]);
  assert.ok(lostGreen(g, [5, 6, 8, 9]));
  const back = world(); // restored: issue 2 back to A, prior B
  const r = await targetsFromEvent({ ...issEv(2, M(50)), gh: back, allowlist: AL });
  assert.deepEqual(r.targets, [5, 6, 8, 9]); assert.equal(r.error, undefined);
});
test("#188-B11 new trusted-root issue (opened) and untrusted-author prior are not instructions", async () => {
  const o = await targetsFromEvent({ name: "issues", payload: { action: "opened", issue: { number: 2 } }, gh: world(), allowlist: AL });
  assert.deepEqual(o.targets, [5, 6]);
  // issue authored by an untrusted user: its prior marker is ignored (rootMarker trusted-PM only) => unprovable unless history
  const g = world({ issues: { 2: iss(2, 50, { user: MAL }) }, pulls: [pr(5, 2, 0), pr(6, 3, 1), pr(8, 51, 50), pr(9, 52, 50)] });
  const r = await targetsFromEvent({ ...issEv(2, M(1)), gh: g, allowlist: AL });
  assert.ok(r.error); assert.deepEqual(r.targets, [5, 6, 8, 9]);
});
test("#188-C workflows: plan error with NON-EMPTY targets still runs refresh (!cancelled), single writer step, shared lock group in both files", () => {
  for (const f of ["quality-gate-events.yml", "quality-gate.yml"]) {
    const y = readFileSync(new URL(`../../.github/workflows/${f}`, import.meta.url), "utf8");
    assert.match(y, /refresh:[\s\S]*?needs: plan[\s\S]*?if: \$\{\{ !cancelled\(\) && needs\.plan\.outputs\.targets != '' && needs\.plan\.outputs\.targets != '\[\]' \}\}/);
    assert.match(y, /fail closed on root\/enumeration diagnostic[\s\S]*?exit 1/);
    assert.match(y, /group: quality-gate-pr-\$\{\{ matrix\.pr \}\}/);
    assert.equal((y.match(/event-route\.mjs --pr/g) ?? []).length, 1);
  }
});
