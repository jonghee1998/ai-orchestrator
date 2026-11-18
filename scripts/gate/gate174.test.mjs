// Issue #174 negative/integration tests: shared verdict on BOTH entrypoints, request semantics, dev-analysis timing, real check command.
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateGate } from "./quality-gate.mjs";
import { runCheck } from "./check.mjs";
import { reviewEvidence } from "../handoff/lifecycle.mjs";
import { normalizeCodexReviews } from "../handoff/lifecycle-evidence.mjs";
import { resolveRootCorrections, correctionMarker } from "../handoff/root-corrections.mjs";
import { CODEX_BOT } from "../handoff/core.mjs";

const OWNER = { login: "jonghee1998", id: 129052128, type: "User" };
const MAL = { login: "mallory", id: 6, type: "User" };
const BOT = { login: CODEX_BOT.login, id: CODEX_BOT.id, type: "Bot" };
const HEAD = "a".repeat(40), OLD = "b".repeat(40);
const T = (h) => `2026-11-18T0${h}:00:00Z`;
const gate = (name, a, user = OWNER, at = T(0)) => ({ user, created_at: at, updated_at: at, body: `<!-- gate:${name}:v1 ${a} -->` });
const st = (sha, { unresolved = false, sec = "completed", secUnresolved = false, status = "completed" } = {}) => ({ code_review: { commit_sha: sha, has_unresolved_findings: unresolved, status }, security_review: { commit_sha: sha, status: sec, has_unresolved_findings: secUnresolved } });
const codex = (obj, id = 1) => ({ id, user: BOT, body: `<!-- codex-review-state:v1 ${JSON.stringify(obj)} -->` });
const clean = () => codex(st(HEAD));
const rest = () => [gate("pm-scope", "issue=1"), { ...gate("dev-analysis", "issue=1", OWNER, T(1)), trustedWriter: true }, gate("self-test", `issue=1 sha=${HEAD} typecheck=pass test=pass build=pass`), gate("codex-impact", `issue=1 sha=${HEAD} verdict=pass`), gate("pm-compare", `issue=1 sha=${HEAD} verdict=pass`)];
const viaGate = (reviews) => evaluateGate({ issue: 1, head: HEAD, items: [...rest(), ...reviews], firstCodeCommitAt: T(2) });
const viaLifecycle = (reviews) => reviewEvidence({ pr: { number: 5, user: { login: "dev" } }, sha: HEAD, reviews: normalizeCodexReviews(reviews), req: 1, integrationTarget: "main" });

test("#174-1 both entrypoints agree: clean passes, every contradictory/invalid evidence is BLOCKED", () => {
  assert.equal(viaGate([clean()]).status, "pass");
  assert.equal(viaLifecycle([clean()]).independent, true);
  const dupMarker = { id: 9, user: BOT, body: `<!-- codex-review-state:v1 ${JSON.stringify(st(HEAD))} --> <!-- codex-review-state:v1 ${JSON.stringify(st(HEAD, { unresolved: true }))} -->` };
  const malformed = { id: 9, user: BOT, body: `<!-- codex-review-state:v1 {not json} --> ${HEAD}` };
  const cases = {
    "opposed code flags": [clean(), codex(st(HEAD, { unresolved: true }), 2)],
    "opposed security flags": [clean(), codex(st(HEAD, { secUnresolved: true }), 2)],
    "multi-marker receipt": [clean(), dupMarker],
    "malformed receipt naming sha": [clean(), malformed],
    "security missing (code-only)": [codex(st(HEAD, { sec: "not_run" }))],
    "stale sha only": [codex(st(OLD))],
    "clean then later unresolved (order reversal)": [clean(), codex(st(HEAD, { unresolved: true }), 3)],
    "unresolved then later clean (order reversal)": [codex(st(HEAD, { unresolved: true }), 2), codex(st(HEAD), 3)],
  };
  for (const [name, rv] of Object.entries(cases)) {
    assert.notEqual(viaGate(rv).status, "pass", `gate: ${name}`);
    assert.equal(viaLifecycle(rv).independent, false, `lifecycle: ${name}`);
  }
  for (const k of ["opposed code flags", "opposed security flags", "multi-marker receipt", "clean then later unresolved (order reversal)"]) assert.equal(viaGate(cases[k]).stages.codex_review.status, "blocked", k);
  // duplicated identical receipts are not silently accepted by the gate
  assert.equal(viaGate([clean(), codex(st(HEAD), 2)]).stages.codex_review.reason, "duplicate_receipts_on_exact_head");
  assert.equal(viaGate([{ ...clean(), user: MAL }]).stages.codex_review.status, "blocked", "forged author");
});

const mk = (n, pr, sha = HEAD) => ({ user: OWNER, created_at: T(1), body: correctionMarker({ root: 146, n, pr, sha }) });
const req = (round, pr, sha) => ({ user: OWNER, created_at: T(1), kind: "issue", body: `<!-- gpt-pm-followup:pr${pr}:${sha}:claude:revise:${round} -->` });
const others = [1, 2, 3, 4, 5, 6, 7].map((n) => mk(n, 100 + n, String(n).repeat(40)));
test("#174-2 correction request: before execution = next count, after own n marker = own n", () => {
  const request = { pr: 173, sha: HEAD };
  // before: n1..n7 recorded elsewhere, request revise:8 => ok (count 7)
  assert.equal(resolveRootCorrections([...others, req(8, 173, HEAD)], 146, 7, { request }).count, 7);
  // before: revise:7 when 7 are consumed => mismatch (cannot lower/reuse)
  assert.equal(resolveRootCorrections([...others, req(7, 173, HEAD)], 146, 7, { request }).error, "root_correction_request_mismatch");
  // after: own marker n8 for destination PR 175 => re-evaluation accepted only with proven destination
  const dest = (ok) => ({ pr: 175, sha: "c".repeat(40), ancestryOk: ok });
  const after = [...others, mk(8, 175, OLD), req(8, 173, HEAD)];
  assert.equal(resolveRootCorrections(after, 146, 8, { request, destination: dest(true) }).count, 8);
  assert.equal(resolveRootCorrections(after, 146, 8, { request, destination: dest(false) }).error, "root_correction_request_mismatch", "unproven ancestry");
  assert.equal(resolveRootCorrections(after, 146, 8, { request, destination: { pr: 999, sha: OLD, ancestryOk: true } }).error, "root_correction_request_mismatch", "other PR cannot claim n8");
  assert.equal(resolveRootCorrections(after, 146, 8, { request }).error, "root_correction_request_mismatch", "no destination");
  // conflicting marker: request names 8 but own marker says 9 => rejected / out of range
  assert.ok(resolveRootCorrections([...others, mk(9, 175, OLD), req(8, 173, HEAD)], 146, 8, { request, destination: dest(true) }).error);
  // replay of an old request (revise:3) never lowers the count
  assert.equal(resolveRootCorrections([...others, req(3, 150, OLD)], 146, 7, { request: { pr: 150, sha: OLD } }).error, "root_correction_request_mismatch");
  assert.equal(resolveRootCorrections([...others, req(3, 150, OLD)], 146, 7, {}).count, 7);
});

test("#174-3 dev-analysis timing uses last modification, not created_at alone", () => {
  const an = (o) => [...rest().filter((x) => !x.body.includes("dev-analysis")), { ...gate("dev-analysis", "issue=1"), trustedWriter: true, ...o }, clean()];
  const run = (o, code = T(2)) => evaluateGate({ issue: 1, head: HEAD, items: an(o), firstCodeCommitAt: code }).stages.dev_analysis;
  assert.equal(run({ created_at: T(1), updated_at: T(1) }).status, "pass");
  assert.equal(run({ created_at: T(0), updated_at: "2026-11-18T01:30:00Z" }).status, "pass", "edited before code");
  assert.equal(run({ created_at: T(1), updated_at: T(3) }).reason, "analysis_edited_after_code");
  assert.equal(run({ created_at: T(1), updated_at: undefined }).reason, "analysis_revision_history_unavailable");
  assert.equal(run({ created_at: T(1), updated_at: "garbage" }).status, "unknown");
  assert.equal(run({ created_at: T(2), updated_at: T(2) }).status, "blocked", "equal timestamp");
  assert.equal(run({ created_at: T(1), updated_at: T(0) }).status, "unknown", "updated before created is malformed");
  assert.equal(run({ user: MAL, trustedWriter: false }).status, "blocked", "forged writer ignored");
  assert.equal(run({ body: "<!-- gate:dev-analysis:v1 issue=2 -->" }).status, "blocked", "wrong issue");
  assert.equal(run({ body: "<!-- gate:dev-analysis:v1 issue= -->" }).status, "blocked", "malformed marker");
  assert.equal(run({ created_at: T(1), updated_at: T(1) }, "none").status, "unknown");
});

// fake GitHub for the real check command
const fakeGh = ({ comments = [], issueBody = "", commitAt = T(2), head = HEAD, published } = {}) => ({
  getPull: async () => ({ number: 5, user: { id: 7, login: "dev" }, head: { sha: head }, body: "Closes #1", created_at: T(2), updated_at: T(2) }),
  getIssue: async () => ({ number: 1, user: OWNER, body: issueBody, created_at: T(0), updated_at: T(0) }),
  listPullCommits: async () => [{ commit: { committer: { date: commitAt } } }],
  listIssueComments: async (n) => (n === 1 ? comments : []),
  createCommitStatus: async (sha, s) => published?.push({ sha, ...s }),
});
const c = (id, o) => ({ id, created_at: T(1), updated_at: T(1), ...o });
test("#174-4 real check command: omission/tampering never passes; stages split; status published", async () => {
  const pub = [];
  const preOk = [c(1, gate("pm-scope", "issue=1")), c(2, { ...gate("dev-analysis", "issue=1", { login: "dev", id: 7, type: "User" }, T(1)) }), c(3, gate("self-test", `issue=1 sha=${HEAD} typecheck=pass test=pass build=pass`))];
  assert.equal((await runCheck({ gh: fakeGh({ comments: preOk, published: pub }), prNumber: 5, stage: "pre-pr", publish: true })).status, "pass");
  assert.deepEqual([pub[0].state, pub[0].context, pub[0].sha], ["success", "quality-gate/pre-pr", HEAD]);
  // final without Codex/PM compare => not pass (pending/failure), but pre-pr alone does not deadlock on them
  const fin = await runCheck({ gh: fakeGh({ comments: preOk, published: pub }), prNumber: 5, stage: "final", publish: true });
  assert.notEqual(fin.status, "pass"); assert.notEqual(pub.at(-1).state, "success");
  // omission of each pre-pr receipt
  for (let i = 0; i < 3; i++) assert.notEqual((await runCheck({ gh: fakeGh({ comments: preOk.filter((_, j) => j !== i) }), prNumber: 5, stage: "pre-pr" })).status, "pass", `omit ${i}`);
  // tampering: analysis edited after first commit; self-test for stale sha; forged PM scope; code moved on
  assert.notEqual((await runCheck({ gh: fakeGh({ comments: [preOk[0], { ...preOk[1], updated_at: T(5) }, preOk[2]] }), prNumber: 5, stage: "pre-pr" })).status, "pass");
  assert.notEqual((await runCheck({ gh: fakeGh({ comments: [preOk[0], preOk[1], c(3, gate("self-test", `issue=1 sha=${OLD} typecheck=pass test=pass build=pass`))] }), prNumber: 5, stage: "pre-pr" })).status, "pass");
  assert.notEqual((await runCheck({ gh: fakeGh({ comments: [c(1, { ...gate("pm-scope", "issue=1"), user: MAL }), preOk[1], preOk[2]] }), prNumber: 5, stage: "pre-pr" })).status, "pass");
  // evidence fetch failure => unknown (never pass); unknown stage => blocked
  const broken = { ...fakeGh(), listIssueComments: async () => { throw new Error("pagination bound exceeded"); } };
  assert.equal((await runCheck({ gh: broken, prNumber: 5, stage: "pre-pr" })).status, "unknown");
  assert.equal(evaluateGate({ issue: 1, head: HEAD, items: [], stage: "off" }).status, "blocked");
});
