// Issue #136 (T5) — dry-run lifecycle tests.
import test from "node:test";
import assert from "node:assert/strict";
import { orchKey, parseOrchKey, planLifecycle, replay, recoverAmbiguousPost, eventPlan, recordMarker, validateTarget, MAX_ROUNDS } from "./lifecycle.mjs";
import { CODEX_BOT } from "./core.mjs";

const SHA = "a".repeat(40), OLD = "b".repeat(40), BASE = "c".repeat(40);
const T = "codex/issue-92-mobile-v2";
const BOT = { login: CODEX_BOT.login, id: CODEX_BOT.id, type: "Bot" };
const OWNER = { login: "jonghee1998", id: 129052128, type: "User" };
const WRITER = { login: "github-actions[bot]", id: 1, type: "Bot" };
const MAL = { login: "mallory", id: 6, type: "User" };
const pr = (x = {}) => ({ number: 9, state: "open", user: OWNER, head: { ref: "claude/x", sha: SHA }, base: { ref: T, sha: BASE }, ...x });
const review = (x = {}) => ({ user: BOT, commit_sha: SHA, status: "completed", has_unresolved_findings: false, ...x });
const accept = (round = 1, sha = SHA, user = OWNER) => ({ id: 5, user, body: `<!-- pm-accept:${orchKey({ req: 136, pr: 9, step: "accept", round })} sha=${sha} -->` });
const base = (x = {}) => ({ req: 136, round: 1, integrationTarget: T, pr: pr(), expectedHead: SHA, expectedBase: BASE, reviews: [review()], comments: [], ...x });

test("key format is strict", () => {
  assert.equal(orchKey({ req: 136, pr: 9, step: "review", round: 2 }), "orch:v1:req136:pr9:review:r2");
  assert.deepEqual(parseOrchKey("orch:v1:req136:pr9:review:r2"), { req: 136, pr: 9, step: "review", round: 2 });
  assert.equal(parseOrchKey("orch:v1:req1:pr2:merge:r1"), null);
  assert.throws(() => orchKey({ req: 1, pr: 2, step: "merge", round: 1 }));
});

test("replay same event 3 times -> one logical plan, no writes executed", () => {
  const r = replay(base(), 3);
  assert.equal(r.distinctPlans, 1);
  assert.equal(r.plan.live, false);
  assert.equal(r.plan.mode, "dry-run");
  assert.equal(r.plan.step, "accept");
});

test("same-account PM marker is self-report, never authenticated authority; completion withheld", () => {
  const p = planLifecycle(base({ comments: [accept()], ci: { sha: SHA, status: "success" }, deployment: { sha: SHA, env: "dev", status: "success" } }));
  assert.equal(p.authority, "self_reported_marker");
  assert.equal(p.completion, "withheld");
  assert.equal(p.why, "pm_acceptance_not_authenticated_t6");
});

test("PM acceptance bound to exact SHA and trusted identity", () => {
  assert.equal(planLifecycle(base({ comments: [accept(1, OLD)] })).step, "accept");
  assert.equal(planLifecycle(base({ comments: [accept(1, SHA, MAL)] })).step, "accept");
});

test("no false completion before integration CI and exact dev deploy", () => {
  const c = [accept()];
  assert.equal(planLifecycle(base({ comments: c })).step, "await_ci_deploy");
  assert.equal(planLifecycle(base({ comments: c, ci: { sha: OLD, status: "success" }, deployment: { sha: SHA, env: "dev", status: "success" } })).why, "integration_ci_not_green_on_exact_sha");
  assert.equal(planLifecycle(base({ comments: c, ci: { sha: SHA, status: "success" }, deployment: { sha: OLD, env: "dev", status: "success" } })).why, "dev_deployment_not_proven_on_exact_sha");
  assert.equal(planLifecycle(base({ comments: c, ci: { sha: SHA, status: "success" }, deployment: { sha: SHA, env: "production", status: "success" } })).completion, "withheld");
});

test("stale review does not count; self-authored/untrusted review is not independent", () => {
  assert.equal(planLifecycle(base({ reviews: [review({ commit_sha: OLD })] })).why, "stale_review_only");
  assert.equal(planLifecycle(base({ reviews: [{ ...review(), user: MAL }] })).why, "no_independent_review_on_exact_head");
  assert.equal(planLifecycle(base({ reviews: [review({ has_unresolved_findings: true })] })).step, "revise");
});

test("integration target only: main rejected, base mismatch, head mismatch, closed", () => {
  assert.equal(planLifecycle(base({ integrationTarget: "main", pr: pr({ base: { ref: "main", sha: BASE } }) })).reason, "integration_target_forbidden");
  assert.equal(planLifecycle(base({ pr: pr({ base: { ref: "main", sha: BASE } }) })).reason, "base_not_integration_target");
  assert.equal(planLifecycle(base({ expectedHead: OLD })).reason, "head_mismatch");
  assert.equal(planLifecycle(base({ expectedBase: OLD })).reason, "base_mismatch");
  assert.equal(planLifecycle(base({ pr: pr({ state: "closed" }) })).reason, "pr_not_open");
});

test("replacement PR: ancestry proven, no stacks, superseded must be closed", () => {
  const sup = { state: "closed", base: { ref: T }, head: { ref: "claude/old", sha: OLD } };
  const ok = base({ superseded: sup, ancestry: "ahead" });
  assert.equal(validateTarget(ok), null);
  assert.equal(validateTarget({ ...ok, ancestry: "diverged" }), "replacement_ancestry_unproven");
  assert.equal(validateTarget({ ...ok, superseded: { ...sup, state: "open" } }), "superseded_not_closed");
  assert.equal(validateTarget({ ...ok, pr: pr({ base: { ref: "claude/old", sha: BASE } }) }), "base_not_integration_target");
  assert.equal(validateTarget({ ...ok, superseded: { ...sup, head: { ref: "claude/x" } } }), "replacement_stack");
});

test("round cap", () => {
  assert.equal(planLifecycle(base({ round: MAX_ROUNDS + 1 })).reason, "round_cap_exceeded");
  assert.equal(planLifecycle(base({ round: MAX_ROUNDS, reviews: [review({ has_unresolved_findings: true })] })).reason, "round_cap_reached_before_revision");
});

test("duplicate done record dedupes; forged record ignored", () => {
  const key = orchKey({ req: 136, pr: 9, step: "accept", round: 1 });
  const rec = (user) => ({ user, body: recordMarker(key, "done") });
  assert.equal(planLifecycle(base({ comments: [rec(WRITER)] })).reason, "duplicate_key_done");
  assert.equal(planLifecycle(base({ comments: [rec(MAL)] })).step, "accept");
});

test("structured completion/blocked events dedupe", () => {
  const key = orchKey({ req: 136, pr: 9, step: "blocked", round: 1 });
  assert.equal(eventPlan({ kind: "blocked", req: 136, pr: 9, round: 1 }).action, "emit_event");
  assert.equal(eventPlan({ kind: "blocked", req: 136, pr: 9, round: 1, existing: [{ user: WRITER, body: recordMarker(key, "done") }] }).reason, "event_already_recorded");
});

test("ambiguous POST recovery fails closed", () => {
  const key = orchKey({ req: 136, pr: 9, step: "revise", round: 1 });
  assert.equal(recoverAmbiguousPost({ key, lookup: { complete: false, matches: [] } }).reason, "ambiguous_post_lookup_incomplete");
  assert.equal(recoverAmbiguousPost({ key, lookup: undefined }).action, "blocked");
  assert.equal(recoverAmbiguousPost({ key, lookup: { complete: true, matches: [{ ref: 1 }, { ref: 2 }] } }).reason, "ambiguous_post_duplicate_matches");
  assert.equal(recoverAmbiguousPost({ key, lookup: { complete: true, matches: [] } }).action, "blocked");
  assert.equal(recoverAmbiguousPost({ key, lookup: { complete: true, matches: [{ ref: 7 }] } }).ref, 7);
});
