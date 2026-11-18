// Issue #178 — live root-wide failure history through the REAL runCheck entrypoint (fake API, both stages) + equivalent missing-input-as-empty guards.
import test from "node:test";
import assert from "node:assert/strict";
import { runCheck, collectGateInput } from "./check.mjs";
import { evaluateGate } from "./quality-gate.mjs";
import { resolveFailHistory } from "./fail-history.mjs";

const OWNER = { login: "jonghee1998", id: 129052128, type: "User" };
const DEV = { login: "jonghee1998", id: 129052128, type: "User" }; // #182: real PR author is the trusted PM writer (supersedes marker is trusted-PM only)
const MAL = { login: "mallory", id: 6, type: "User" };
const HEAD = "a".repeat(40), F1 = "1".repeat(40), F2 = "2".repeat(40);
const T = (h) => `2026-11-18T0${h}:00:00Z`;
const BR = "codex/issue-92-mobile-v2";
const gate = (name, a, user = OWNER, at = T(0)) => ({ user, created_at: at, updated_at: at, body: `<!-- gate:${name}:v1 ${a} -->` });
const fc = (cls, pr, sha, root = 1) => `<!-- gate:fail-class:v1 root=${root} class=${cls} pr=${pr} sha=${sha} -->`;
const c = (id, o) => ({ id, created_at: T(1), updated_at: T(1), ...o });
const base = () => [c(1, gate("pm-scope", "issue=1")), c(2, gate("dev-analysis", "issue=1", DEV, T(1))), c(3, gate("self-test", `issue=1 sha=${HEAD} typecheck=pass test=pass build=pass`))];
const failTwice = (extra = {}) => [c(10, { user: OWNER, body: fc("evidence-scope", 90, F1) }), c(11, { user: OWNER, body: fc("evidence-scope", 91, F2) })];

function fake({ comments = base(), prComments = [], extraIssues = [], extraPulls = [], other = {}, hooks = {}, statuses = [] } = {}) {
  const w = { comments, prComments, extraIssues, extraPulls, other, head: HEAD };
  const call = async (name, f) => { await hooks[name]?.(w); return f(); };
  return {
    w, statuses,
    getPull: () => call("getPull", () => ({ number: 5, state: "open", user: DEV, head: { sha: w.head }, base: { ref: BR }, body: "Closes #1\n<!-- orch-supersedes:v1 none -->", created_at: T(2), updated_at: T(2) })),
    getIssue: (n) => call("getIssue", () => ({ number: n, user: OWNER, body: "<!-- orch-root-request:v1 #1 -->", created_at: T(0), updated_at: T(0) })),
    listPullCommits: () => call("listPullCommits", () => [{ commit: { committer: { date: T(2) } } }]),
    listIssueComments: (n) => call("listIssueComments", () => (n === 1 ? w.comments : n === 5 ? w.prComments : w.other[n] ?? [])),
    listIssues: () => call("listIssues", () => w.extraIssues),
    listPulls: () => call("listPulls", () => w.extraPulls),
    createCommitStatus: (sha, s) => call("createCommitStatus", () => { statuses.push({ sha, ...s }); }),
  };
}
const both = async (g, f) => { for (const stage of ["pre-pr", "final"]) await f(await runCheck({ gh: g, prNumber: 5, stage, publish: true }), stage); };
const rcaUnmet = (r) => r.unmet.some((u) => u.startsWith("rca:"));
// `final` also needs Codex/impact/PM receipts that are out of scope here: assert the RCA stage is clear on both, full pass on pre-pr.
const clear = (r, s) => { assert.equal(rcaUnmet(r), false, `${s}:${JSON.stringify(r.unmet)}`); if (s === "pre-pr") assert.equal(r.status, "pass", JSON.stringify(r.unmet)); };

test("#178-1 live collector supplies root-wide failHistory: repeated same class with NO RCA is blocked at the real entrypoint (both stages)", async () => {
  const g = fake({ comments: [...base(), ...failTwice()] });
  await both(g, (r, s) => { assert.equal(r.status, "blocked", s); assert.ok(r.unmet.some((u) => u.startsWith("rca:rca_required_for_repeated_class:evidence-scope")), JSON.stringify(r.unmet)); });
  assert.ok(g.statuses.some((s) => s.state === "failure"));
});
test("#178-1 failures spread across other root-marked issues/PRs and their comments are counted (multi-chain); valid pre-code RCA passes", async () => {
  const other = { 90: [c(20, { user: OWNER, body: fc("evidence-scope", 90, F1) })] };
  const mk = (n, kind) => ({ number: n, user: OWNER, body: `<!-- orch-root-request:v1 #1 -->\n${kind === "pr" ? fc("evidence-scope", 91, F2) : ""}`, created_at: T(0), updated_at: T(0), ...(kind === "pr" ? {} : {}) });
  const g = fake({ extraIssues: [mk(90, "issue")], extraPulls: [mk(91, "pr")], other });
  await both(g, (r) => assert.equal(r.status, "blocked", JSON.stringify(r.unmet)));
  const ok = fake({ comments: [...base(), c(30, gate("rca", "issue=1 class=evidence-scope", OWNER, T(0)))], extraIssues: [mk(90, "issue")], extraPulls: [mk(91, "pr")], other });
  await both(ok, clear);
});
test("#178-1 single failure, different classes, unrelated/new requirement => not blocked", async () => {
  for (const comments of [[...base(), c(10, { user: OWNER, body: fc("evidence-scope", 90, F1) })], [...base(), ...failTwice().map((x, i) => ({ ...x, body: fc(i ? "other-class" : "evidence-scope", 90 + i, i ? F2 : F1) }))]])
    await both(fake({ comments }), clear);
});
test("#178-1 duplicated/stale/replayed copies of ONE failure count once; spoofed (untrusted) receipts are ignored", async () => {
  const dup = [c(10, { user: OWNER, body: fc("evidence-scope", 90, F1) }), c(11, { user: OWNER, body: fc("evidence-scope", 90, F1) }), c(12, { user: OWNER, body: `${fc("evidence-scope", 90, F1)}\n${fc("evidence-scope", 90, F1)}` })];
  await both(fake({ comments: [...base(), ...dup] }), clear);
  const spoof = [c(10, { user: OWNER, body: fc("evidence-scope", 90, F1) }), c(11, { user: MAL, body: fc("evidence-scope", 91, F2) })];
  await both(fake({ comments: [...base(), ...spoof] }), clear);
  // a spoofed RCA never satisfies a real repeated failure
  await both(fake({ comments: [...base(), ...failTwice(), c(30, gate("rca", "issue=1 class=evidence-scope", MAL))] }), (r) => assert.equal(r.status, "blocked"));
});
test("#178-1 RCA must PRECEDE code: edited after the first code commit => blocked; unbound class/issue => blocked", async () => {
  const late = { ...c(30, gate("rca", "issue=1 class=evidence-scope", OWNER, T(0))), updated_at: T(5) };
  await both(fake({ comments: [...base(), ...failTwice(), late] }), (r) => assert.ok(r.unmet.some((u) => u.startsWith("rca:rca_not_before_code")), JSON.stringify(r.unmet)));
  for (const a of ["issue=1 class=other", "issue=77 class=evidence-scope"])
    await both(fake({ comments: [...base(), ...failTwice(), c(30, gate("rca", a))] }), (r) => assert.equal(r.status, "blocked", a));
});
test("#178-2 malformed / other-root markers and unreadable or partial history => BLOCKED, never an empty default", async () => {
  for (const body of ["<!-- gate:fail-class:v1 root=1 class=Bad_Class pr=9 sha=zz -->", fc("evidence-scope", 90, F1, 999), "<!-- gate:fail-class:v1 root=1 class=x -->"])
    await both(fake({ comments: [...base(), c(10, { user: OWNER, body })] }), (r) => { assert.equal(r.status, "blocked", body); assert.match(r.unmet.join(), /fail_history/); });
  for (const where of ["listIssues", "listPulls"]) {
    const g = fake({ hooks: { [where]: () => { throw new Error("pagination bound exceeded"); } } });
    await both(g, (r) => { assert.equal(r.status, "blocked", where); assert.match(r.unmet.join(), /evidence_incomplete/); });
  }
  const g = fake({ hooks: { listIssues: () => { throw new Error("403"); } } });
  await both(g, () => assert.ok(g.statuses.at(-1).state === "failure"));
  const nonArray = { ...fake(), listIssues: async () => ({ message: "partial" }) };
  await both(nonArray, (r) => assert.equal(r.status, "blocked"));
});
test("#178-2 evaluateGate / resolveFailHistory never convert absent history into empty", () => {
  const items = [gate("pm-scope", "issue=1")];
  for (const failHistory of [undefined, null, "x", [1]]) assert.equal(evaluateGate({ issue: 1, head: HEAD, items, failHistory, firstCodeCommitAt: T(2) }).stages.rca.status, "unknown");
  assert.equal(evaluateGate({ issue: 1, head: HEAD, items, firstCodeCommitAt: T(2) }).status !== "pass", true);
  assert.equal(resolveFailHistory(undefined, 1).error, "fail_history_unavailable");
  assert.deepEqual(resolveFailHistory([], 1).failHistory, []);
});
test("#178-3 edits/deletes/races of failure history between collect and publish => pending, never green", async () => {
  const delRace = fake({ comments: [...base(), c(10, { user: OWNER, body: fc("evidence-scope", 90, F1) })], hooks: { listPullCommits: (w) => { w.n = (w.n ?? 0) + 1; } } });
  let n = 0; delRace.listIssueComments = (async (orig) => async (i) => { const r = await orig(i); if (i === 1 && ++n === 3) delRace.w.comments = delRace.w.comments.filter((x) => x.id !== 10); return r; })(delRace.listIssueComments);
  const r = await runCheck({ gh: delRace, prNumber: 5, stage: "pre-pr", publish: true });
  assert.notEqual(r.status, "pass"); assert.notEqual(delRace.statuses.at(-1).state, "success");
  const a = await collectGateInput(fake({ comments: [...base()] }), 5, "final"), b = await collectGateInput(fake({ comments: [...base(), c(10, { user: OWNER, body: fc("evidence-scope", 90, F1) })] }), 5, "final");
  assert.notEqual(a.fingerprint, b.fingerprint, "history is part of the fingerprint");
  assert.deepEqual(a.gate.failHistory, []); assert.deepEqual(b.gate.failHistory, ["evidence-scope"]);
});
