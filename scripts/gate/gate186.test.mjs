// Issue #186 — (A) PR event whose link/marker is absent/invalid is a LOST source (never direct-PR-only), through the REAL
// router -> plan -> refresh -> runCheck entrypoints; (B) quality-gate-events subscribes to issues.opened and a newly opened trusted-root
// issue recomputes siblings. Fake GitHub API only: NOT a real GitHub E2E (the issues/issue_comment workflow is inert off the default branch).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { targetsFromEvent, handleEvent } from "./event-route.mjs";
import { createPrLock } from "./pr-lock.mjs";

const OWNER = { login: "jonghee1998", id: 129052128, type: "User" };
const MAL = { login: "mallory", id: 6, type: "User" };
const BR = "codex/issue-92-mobile-v2", AL = [BR];
const T0 = "2026-11-18T00:00:00Z";
const iss = (number, root, o = {}) => ({ number, user: OWNER, body: root ? `<!-- orch-root-request:v1 #${root} -->\nRCA` : "plain", created_at: T0, updated_at: T0, ...o });
const sha = (n) => String(n % 10).repeat(40);
const pr = (number, linked, o = {}) => ({ number, state: "open", user: OWNER, head: { sha: sha(number), repo: { full_name: "o/r" } }, base: { ref: BR, repo: { full_name: "o/r" } }, body: `Closes #${linked}\n<!-- orch-root-request:v1 #1 -->`, created_at: T0, updated_at: T0, ...o });
const CTX = ["quality-gate/pre-pr", "quality-gate/final"];
function world(o = {}) {
  const issues = { 1: iss(1, 1), 2: iss(2, 1), 3: iss(3, 1), 50: iss(50, 50), ...o.issues };
  const pulls = o.pulls ?? [pr(5, 2), pr(6, 3), pr(8, 50, { body: "Closes #50\n<!-- orch-root-request:v1 #50 -->" })];
  const statuses = [];
  for (const p of pulls) for (const c of CTX) statuses.push({ sha: p.head.sha, context: c, state: "success" });
  return {
    statuses,
    getIssue: async (n) => { if (o.gone?.includes(n)) throw new Error("404"); return issues[n] ?? { number: n, user: OWNER, body: "plain" }; },
    getPull: async (n) => pulls.find((p) => p.number === n) ?? pr(n, 1),
    listPulls: async () => { if (o.listPulls) return o.listPulls(); return pulls; },
    listIssueComments: async () => [], listIssues: async () => o.listIssues ?? [], listPullCommits: async () => [],
    createCommitStatus: async (s, st) => { statuses.push({ sha: s, context: st.context, state: st.state }); },
  };
}
const last = (g, n, c) => g.statuses.filter((s) => s.sha === sha(n) && s.context === c).at(-1)?.state;
const lostGreen = (g, ns) => ns.every((n) => CTX.every((c) => last(g, n, c) !== "success"));
const keptGreen = (g, ns) => ns.every((n) => CTX.every((c) => last(g, n, c) === "success"));
const prEv = (n) => ({ name: "pull_request_target", payload: { pull_request: { number: n } } });
const run = (g, e) => handleEvent({ ...e, gh: g, allowlist: AL, lock: createPrLock() });

test("#186-A1 source PR loses BOTH linked issue and root marker: ALL eligible siblings lose green through real runCheck", async () => {
  const g = world({ pulls: [pr(5, 2, { body: "no refs, sole RCA lived here" }), pr(6, 3), pr(7, 2), pr(8, 50, { body: "Closes #50\n<!-- orch-root-request:v1 #50 -->" })] });
  const out = await run(g, prEv(5));
  assert.deepEqual(out.targets, [5, 6, 7, 8]); assert.match(out.error, /root_marker_lost/);
  assert.ok(lostGreen(g, [5, 6, 7, 8]), JSON.stringify(g.statuses.slice(-10)));
  assert.ok(g.statuses.every((s, i) => i < 8 || s.state !== "success"));
});
test("#186-A2 only the link absent / only the marker absent => lost policy, never direct-only", async () => {
  const noLink = await targetsFromEvent({ ...prEv(5), gh: world({ pulls: [pr(5, 2, { body: "<!-- orch-root-request:v1 #1 -->" }), pr(6, 3), pr(8, 50)] }), allowlist: AL });
  assert.deepEqual(noLink.targets, [5, 6, 8]); assert.match(noLink.error, /root_marker_lost/);
  // marker absent, another PR linked to the same issue carries a verified marker => history recovers root 1 (siblings of root 1 only)
  const rec = await targetsFromEvent({ ...prEv(5), gh: world({ pulls: [pr(5, 2, { body: "Closes #2" }), pr(6, 3), pr(7, 2), pr(8, 50)] }), allowlist: AL });
  assert.deepEqual([rec.targets, rec.error], [[5, 6, 7], undefined]);
  // marker absent, no independent history => superset
  const none = await targetsFromEvent({ ...prEv(5), gh: world({ pulls: [pr(5, 2, { body: "Closes #2" }), pr(6, 3), pr(8, 50)] }), allowlist: AL });
  assert.deepEqual(none.targets, [5, 6, 8]); assert.match(none.error, /root_marker_lost/);
});
test("#186-A3 ambiguous / forged (untrusted author) / mismatched marker => superset", async () => {
  const amb = await targetsFromEvent({ ...prEv(5), gh: world({ pulls: [pr(5, 2, { body: "Closes #2\n<!-- orch-root-request:v1 #1 -->\n<!-- orch-root-request:v1 #50 -->" }), pr(6, 3), pr(8, 50)] }), allowlist: AL });
  assert.deepEqual(amb.targets, [5, 6, 8]);
  const forged = await targetsFromEvent({ ...prEv(5), gh: world({ pulls: [pr(5, 2, { user: MAL }), pr(6, 3), pr(8, 50)] }), allowlist: AL });
  assert.deepEqual(forged.targets, [5, 6, 8]);
  const mism = await targetsFromEvent({ ...prEv(5), gh: world({ pulls: [pr(5, 2, { body: "Closes #2\n<!-- orch-root-request:v1 #50 -->" }), pr(6, 3), pr(8, 50)] }), allowlist: AL });
  assert.deepEqual(mism.targets, [5, 6, 8]); assert.match(mism.error, /root_marker_conflict/);
});
test("#186-A4 closed historical source PR edited with no linked/marker, and deleted/unreadable/partial enumeration", async () => {
  const closed = world({ pulls: [pr(5, 2), pr(6, 3), pr(9, 2, { state: "closed", body: "nothing" })] });
  closed.getPull = async (n) => ({ ...(n === 9 ? pr(9, 2, { state: "closed", body: "nothing" }) : pr(n, 3)) });
  const r = await targetsFromEvent({ ...prEv(9), gh: closed, allowlist: AL });
  assert.deepEqual(r.targets, [5, 6, 9]); assert.match(r.error, /root_marker_lost/);
  const gone = await targetsFromEvent({ ...prEv(5), gh: world({ gone: [2] }), allowlist: AL });
  assert.ok([5, 6, 8].every((n) => gone.targets.includes(n)));
  const blocked = await targetsFromEvent({ ...prEv(5), gh: world({ listPulls: () => { throw new Error("502"); } }), allowlist: AL });
  assert.deepEqual([blocked.blocked, blocked.error, blocked.targets], [true, "pr_enumeration_failed", [5]]); assert.match(blocked.stale, /may remain stale/);
});
test("#186-A5 restoration and unrelated verified root: normal routing, no error", async () => {
  const ok = await targetsFromEvent({ ...prEv(5), gh: world(), allowlist: AL });
  assert.deepEqual([ok.targets, ok.error], [[5, 6], undefined]);
  const other = await targetsFromEvent({ ...prEv(8), gh: world(), allowlist: AL });
  assert.deepEqual([other.targets, other.error], [[8], undefined]);
});
test("#186-A6 duplicate / out-of-order events are serialized per PR and never publish green after the lost event", async () => {
  const g = world({ pulls: [pr(5, 2, { body: "bare" }), pr(6, 3)] });
  const lock = createPrLock();
  await Promise.all([handleEvent({ ...prEv(5), gh: g, allowlist: AL, lock }), handleEvent({ ...prEv(5), gh: g, allowlist: AL, lock })]);
  assert.ok(lostGreen(g, [5, 6]));
});

test("#186-B1 quality-gate-events subscribes to issues opened/edited/deleted and issue_comment created/edited/deleted; same lock group, one writer path", () => {
  const ev = readFileSync(new URL("../../.github/workflows/quality-gate-events.yml", import.meta.url), "utf8");
  assert.match(ev, /issues:\s*\n\s*types: \[opened, edited, deleted\]/);
  assert.match(ev, /issue_comment:\s*\n\s*types: \[created, edited, deleted\]/);
  assert.match(ev, /group: quality-gate-pr-\$\{\{ matrix\.pr \}\}/);
  assert.equal((ev.match(/event-route\.mjs --pr/g) ?? []).length, 1); // single writer step
  assert.ok(!/pull_request_target|ref: \$\{\{ github\.event\.pull_request/.test(ev)); // no PR-head checkout / privileged PR code
});
test("#186-B2 issues.opened of a NEW trusted-root issue (same-class fail history/RCA): siblings previously PASS are all recomputed non-green", async () => {
  const g = world({ issues: { 20: iss(20, 1, { body: "<!-- orch-root-request:v1 #1 -->\n<!-- gate:fail-class:v1 root=1 class=stale-status pr=5 sha=" + sha(5) + " -->" }) } });
  const out = await run(g, { name: "issues", payload: { action: "opened", issue: { number: 20 } } });
  assert.deepEqual(out.targets, [5, 6]);
  assert.ok(lostGreen(g, [5, 6])); assert.ok(keptGreen(g, [8]));
});
test("#186-B3 opened issue with missing / other-root marker: lost => superset (missing); verified other root => only that root", async () => {
  const missing = await targetsFromEvent({ name: "issues", payload: { action: "opened", issue: { number: 21 } }, gh: world({ issues: { 21: iss(21, 0) } }), allowlist: AL });
  assert.deepEqual(missing.targets, [5, 6, 8]);
  const other = await targetsFromEvent({ name: "issues", payload: { action: "opened", issue: { number: 50 } }, gh: world(), allowlist: AL });
  assert.deepEqual(other.targets, [8]);
});
