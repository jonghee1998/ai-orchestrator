import test from "node:test";
import assert from "node:assert/strict";
import { evaluateGate, classifyChange } from "./quality-gate.mjs";
import { CODEX_BOT } from "../handoff/core.mjs";

const OWNER = { login: "jonghee1998", id: 129052128, type: "User" };
const MAL = { login: "mallory", id: 6, type: "User" };
const BOT = { login: CODEX_BOT.login, id: CODEX_BOT.id, type: "Bot" };
const HEAD = "a".repeat(40), OLD = "b".repeat(40);
const g = (name, a, user = OWNER, at = "2026-11-18T00:00:00Z") => ({ user, created_at: at, updated_at: at, body: `<!-- gate:${name}:v1 ${a} -->` });
const codex = (sha, unresolved = false, sec = "completed") => ({ user: BOT, body: `<!-- codex-review-state:v1 ${JSON.stringify({ code_review: { commit_sha: sha, has_unresolved_findings: unresolved, status: "completed" }, security_review: { commit_sha: sha, status: sec, has_unresolved_findings: false } })} -->` });
const full = () => [g("pm-scope", "issue=1"), { ...g("dev-analysis", "issue=1", OWNER, "2026-11-18T01:00:00Z") }, g("self-test", `issue=1 sha=${HEAD} typecheck=pass test=pass build=pass`),
  codex(HEAD), g("codex-impact", `issue=1 sha=${HEAD} verdict=pass`), g("pm-compare", `issue=1 sha=${HEAD} verdict=pass`)];
const ev = (items, x = {}) => evaluateGate({ issue: 1, pr: undefined, head: HEAD, items, firstCodeCommitAt: "2026-11-18T02:00:00Z", failHistory: [], ...x });

test("gate passes only when every stage is evidenced", () => { assert.equal(ev(full()).status, "pass"); });
test("NEGATIVE: every missing receipt is blocked/unknown, never pass", () => {
  const items = full();
  for (let i = 0; i < items.length; i++) {
    const r = ev(items.filter((_, j) => j !== i));
    assert.notEqual(r.status, "pass", `without item ${i}`);
    assert.ok(r.unmet.length >= 1);
  }
  assert.equal(ev([]).status, "blocked");
  assert.equal(ev(full().slice(0, 5)).stages.pm_compare.status, "unknown");
});
test("NEGATIVE: untrusted authors, stale SHA, ordering, failed tests, security absent, unresolved findings", () => {
  const swap = (i, o) => full().map((x, j) => (j === i ? o : x));
  assert.equal(ev(swap(0, g("pm-scope", "issue=1", MAL))).stages.pm_scope.status, "blocked");
  assert.equal(ev(swap(5, g("pm-compare", `issue=1 sha=${OLD} verdict=pass`))).stages.pm_compare.status, "unknown", "stale SHA");
  assert.equal(ev(swap(5, g("pm-compare", `issue=1 sha=${HEAD} verdict=fail`))).status, "blocked");
  assert.equal(ev(swap(2, g("self-test", `issue=1 sha=${HEAD} typecheck=pass test=fail build=pass`))).stages.self_test.reason, "self_test_not_pass_on_exact_head");
  assert.equal(ev(swap(2, g("self-test", `issue=1 sha=${OLD} typecheck=pass test=pass build=pass`))).stages.self_test.status, "blocked");
  assert.equal(ev(full(), { firstCodeCommitAt: "2026-11-18T00:30:00Z" }).stages.dev_analysis.reason, "analysis_not_before_code");
  assert.equal(ev(full(), { firstCodeCommitAt: undefined }).stages.dev_analysis.status, "unknown");
  assert.equal(ev(swap(3, codex(HEAD, false, "not_run"))).stages.codex_review.reason, "security_review_absent");
  assert.equal(ev(swap(3, codex(HEAD, true))).stages.codex_review.reason, "codex_findings_unresolved");
  assert.equal(ev(swap(3, codex(OLD))).stages.codex_review.reason, "codex_review_missing_on_exact_head");
  assert.equal(ev(swap(3, { ...codex(HEAD), user: MAL })).stages.codex_review.status, "blocked", "forged Codex receipt");
  assert.equal(ev(full(), { head: undefined }).status, "unknown");
});
test("repeated same-class FAIL requires a root-cause analysis receipt", () => {
  assert.equal(ev(full(), { failHistory: ["evidence-scope", "evidence-scope"] }).stages.rca.status, "blocked");
  assert.equal(ev(full(), { failHistory: ["evidence-scope", "other"] }).status, "pass");
  assert.equal(ev([...full(), g("rca", "issue=1 class=evidence-scope")], { failHistory: ["evidence-scope", "evidence-scope"] }).status, "pass");
  assert.equal(ev([...full(), g("rca", "issue=1 class=evidence-scope", MAL)], { failHistory: ["evidence-scope", "evidence-scope"] }).status, "blocked");
});
test("relabeling a correction as a feature cannot evade the cap", () => {
  assert.deepEqual(classifyChange({ claimed: "feature", supersedesFailedPr: true }), { kind: "correction", conflict: "relabel_ignored", countsTowardCap: true });
  assert.equal(classifyChange({ claimed: "feature", supersedesFailedPr: false }).countsTowardCap, false);
  assert.equal(classifyChange({ claimed: "defect", supersedesFailedPr: false }).countsTowardCap, true);
});
