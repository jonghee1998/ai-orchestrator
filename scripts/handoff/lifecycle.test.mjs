// Issue #136 / #138 — dry-run lifecycle tests (pure planner + real entrypoint with fixture HTTP).
import test from "node:test";
import assert from "node:assert/strict";
import { orchKey, parseOrchKey, planLifecycle, replay, recoverAmbiguousPost, eventPlan, recordMarker, validateTarget, parseConfig, applySimulated, keyState, MAX_ROUNDS } from "./lifecycle.mjs";
import { normalizeCodexReviews, pmAcceptMarkers } from "./lifecycle-evidence.mjs";
import { CODEX_BOT } from "./core.mjs";
import { createClient } from "./github.mjs";
import { handle } from "./main.mjs";

const H = (c) => c.repeat(40);
const SHA = H("a"), OLD = H("b"), BASE = H("c"), MERGE = H("d");
const T = "codex/issue-92-mobile-v2";
const RAW = { allowlist: [T], expectedBase: BASE };
const CFG = parseConfig(RAW);
const BOT = { login: CODEX_BOT.login, id: CODEX_BOT.id, type: "Bot" };
const OWNER = { login: "jonghee1998", id: 129052128, type: "User" };
const WRITER = { login: "github-actions[bot]", id: 1, type: "Bot" };
const MAL = { login: "mallory", id: 6, type: "User" };
const pr = (x = {}) => ({ number: 9, state: "open", merged: false, user: OWNER, head: { ref: "claude/x", sha: SHA }, base: { ref: T, sha: BASE }, ...x });
const mergedPr = (x = {}) => pr({ state: "closed", merged: true, merge_commit_sha: MERGE, ...x });
const review = (x = {}) => ({ trusted: true, user: BOT, commit_sha: SHA, status: "completed", has_unresolved_findings: false, ...x });
const acc = (x = {}) => ({ issue: 136, pr: 9, sha: SHA, target: T, ...x });
const base = (x = {}) => ({ req: 136, round: 1, config: CFG, integrationTarget: T, pr: pr(), expectedHead: SHA, reviews: [review()], pmAccepts: [], pmRevises: [], records: [], ...x });
const mergedBase = (x = {}) => base({ pr: mergedPr(), reviews: [review()], pmAccepts: [acc()],
  merge: { sha: MERGE, tipContainsMerge: true, headContained: true }, ci: { sha: MERGE, status: "success" }, deployment: { sha: MERGE, env: "dev", status: "success" }, ...x });
const rec = (key, state, ref, user = WRITER) => ({ user, body: recordMarker(key, state, ref) });
const K = (step, round = 1, p = 9) => orchKey({ req: 136, pr: p, step, round });

test("key format is strict", () => {
  assert.equal(orchKey({ req: 136, pr: 9, step: "review", round: 2 }), "orch:v1:req136:pr9:review:r2");
  assert.deepEqual(parseOrchKey("orch:v1:req136:pr9:review:r2"), { req: 136, pr: 9, step: "review", round: 2 });
  assert.equal(parseOrchKey("orch:v1:req1:pr2:merge:r1"), null);
  assert.throws(() => orchKey({ req: 1, pr: 2, step: "merge", round: 1 }));
});

test("config: exact allowlist and valid base SHA, malformed fails closed", () => {
  assert.equal(parseConfig(RAW).ok, true);
  for (const bad of [undefined, {}, { allowlist: [], expectedBase: BASE }, { allowlist: ["main"], expectedBase: BASE }, { allowlist: ["codex/*"], expectedBase: BASE },
    { allowlist: [T], expectedBase: "abc" }, { allowlist: [T] }, { allowlist: [T], expectedBase: BASE.toUpperCase() }, { allowlist: [5], expectedBase: BASE }, { allowlist: ["a/../b"], expectedBase: BASE }]) {
    assert.equal(parseConfig(bad).ok, false, JSON.stringify(bad));
  }
  assert.equal(planLifecycle(base({ config: { ok: false, reason: "x" } })).action, "blocked");
  assert.equal(planLifecycle(base({ config: parseConfig({ allowlist: [T], expectedBase: "zz" }) })).reason, "config_expected_base_invalid");
  assert.equal(planLifecycle(base({ integrationTarget: "other", pr: pr({ base: { ref: "other", sha: BASE } }) })).reason, "integration_target_not_allowlisted");
});

test("malformed inputs fail closed", () => {
  for (const x of [{ req: "136" }, { req: 0 }, { round: 0 }, { round: 1.5 }, { pr: pr({ number: "9" }) }, { pr: pr({ state: "weird" }) }, { expectedHead: "abc" }, { pr: pr({ head: undefined }) }, { reviews: [review({ has_unresolved_findings: "no" })] }]) {
    const p = planLifecycle(base(x));
    assert.ok(p.action === "blocked" || p.action === "noop", JSON.stringify(x) + JSON.stringify(p));
    assert.deepEqual(p.writes.filter((w) => !/^$/.test(w.type)).length, 0);
  }
});

test("replay same event -> one logical plan, no writes executed", () => {
  const r = replay(base(), 3);
  assert.equal(r.distinctPlans, 1);
  assert.equal(r.plan.live, false);
  assert.equal(r.plan.step, "accept");
  assert.equal(r.plan.phase, "open_review");
});

test("open review never completes; PM accept on exact SHA+issue+pr+target is only a self-report", () => {
  const p = planLifecycle(base({ pmAccepts: [acc()] }));
  assert.equal(p.completion, "not_applicable_until_merged");
  assert.equal(p.authority, "self_reported_marker");
  assert.equal(p.why, "review_accepted_awaiting_merge_and_integration_evidence");
  for (const bad of [acc({ sha: OLD }), acc({ issue: 1 }), acc({ pr: 8 }), acc({ target: "main" })]) {
    assert.equal(planLifecycle(base({ pmAccepts: [bad] })).authority, "none");
  }
  assert.equal(planLifecycle(base({ pmAccepts: [acc({ sha: OLD })] })).why, "stale_pm_acceptance_only");
});

test("merged PR: separate merge-SHA evidence; eligible evidence shown but completion stays withheld (T6)", () => {
  const p = planLifecycle(mergedBase());
  assert.equal(p.phase, "merged");
  assert.equal(p.mergeSha, MERGE);
  assert.notEqual(p.mergeSha, p.head, "merge SHA != head");
  assert.equal(p.evidenceEligible, true);
  assert.equal(p.completion, "withheld");
  assert.equal(p.why, "pm_acceptance_not_authenticated_t6");
  assert.deepEqual(p.writes, []);
});

test("merged PR: CI/deploy bound to merge SHA, not PR head", () => {
  assert.equal(planLifecycle(mergedBase({ ci: { sha: SHA, status: "success" } })).why, "integration_ci_not_green_on_merge_sha");
  assert.equal(planLifecycle(mergedBase({ ci: { sha: MERGE, status: "pending" } })).why, "integration_ci_not_green_on_merge_sha");
  assert.equal(planLifecycle(mergedBase({ deployment: { sha: SHA, env: "dev", status: "success" } })).why, "dev_deployment_not_proven_on_merge_sha");
  assert.equal(planLifecycle(mergedBase({ deployment: { sha: MERGE, env: "production", status: "success" } })).why, "dev_deployment_not_proven_on_merge_sha");
  assert.equal(planLifecycle(mergedBase({ ci: undefined })).completion, "withheld");
});

test("merged PR: missing merge sha, unverified merge, not on target, squash/non-ancestor all withhold", () => {
  assert.equal(planLifecycle(mergedBase({ pr: mergedPr({ merge_commit_sha: undefined }) })).reason, "merge_sha_missing");
  assert.equal(planLifecycle(mergedBase({ merge: { sha: OLD, tipContainsMerge: true, headContained: true } })).why, "merge_sha_not_verified");
  assert.equal(planLifecycle(mergedBase({ merge: { sha: MERGE, tipContainsMerge: false, headContained: true } })).why, "merge_sha_not_on_integration_target");
  assert.equal(planLifecycle(mergedBase({ merge: { sha: MERGE, tipContainsMerge: true, headContained: "squash" } })).why, "head_ancestry_unproven_squash_or_rebase");
  assert.equal(planLifecycle(mergedBase({ merge: { sha: MERGE, tipContainsMerge: true, headContained: false } })).why, "head_not_ancestor_of_merge_sha");
  assert.equal(planLifecycle(mergedBase({ merge: undefined })).completion, "withheld");
});

test("closed unmerged PR is a noop; merged PR on wrong base is blocked", () => {
  assert.equal(planLifecycle(base({ pr: pr({ state: "closed" }) })).reason, "pr_closed_unmerged");
  assert.equal(planLifecycle(mergedBase({ pr: mergedPr({ base: { ref: "main" } }) })).reason, "base_not_integration_target");
});

test("stale review / conflicting evidence fail closed", () => {
  assert.equal(planLifecycle(base({ reviews: [review({ commit_sha: OLD })] })).why, "stale_review_only");
  assert.equal(planLifecycle(base({ reviews: [{ ...review(), trusted: false }] })).why, "no_independent_review_on_exact_head");
  assert.equal(planLifecycle(base({ reviews: [review({ user: { ...OWNER, type: "Bot" } })], pr: pr({ user: OWNER }) })).why, "no_independent_review_on_exact_head");
  assert.equal(planLifecycle(base({ reviews: [review({ has_unresolved_findings: true })] })).step, "revise");
  assert.equal(planLifecycle(base({ reviews: [review(), review({ has_unresolved_findings: true })] })).reason, "conflicting_review_evidence");
  assert.equal(planLifecycle(base({ pmAccepts: [acc()], pmRevises: [{ pr: 9, sha: SHA, round: 1 }] })).reason, "conflicting_pm_evidence");
  assert.equal(planLifecycle(mergedBase({ reviews: [review(), review({ has_unresolved_findings: true })] })).reason, "conflicting_review_evidence");
});

test("integration target only: head/base/main checks", () => {
  assert.equal(planLifecycle(base({ integrationTarget: "main", pr: pr({ base: { ref: "main", sha: BASE } }) })).reason, "integration_target_not_allowlisted");
  assert.equal(planLifecycle(base({ pr: pr({ base: { ref: "main", sha: BASE } }) })).reason, "base_not_integration_target");
  assert.equal(planLifecycle(base({ expectedHead: OLD })).reason, "head_mismatch");
  assert.equal(planLifecycle(base({ config: parseConfig({ allowlist: [T], expectedBase: OLD }) })).reason, "base_mismatch");
});

test("replacement PR: open or closed superseded OK; merged distinct; exact ancestry bound to both SHAs", () => {
  const sup = (x = {}) => ({ number: 7, state: "open", merged: false, base: { ref: T }, head: { ref: "claude/old", sha: OLD }, ...x });
  const anc = (x = {}) => ({ baseSha: OLD, headSha: SHA, status: "ahead", ...x });
  const ok = base({ superseded: sup(), ancestry: anc() });
  assert.equal(validateTarget(ok), null, "replacement valid while old PR is still open");
  assert.equal(validateTarget({ ...ok, superseded: sup({ state: "closed" }) }), null);
  assert.equal(validateTarget({ ...ok, superseded: sup({ state: "closed", merged: true }) }), "superseded_merged");
  assert.equal(validateTarget({ ...ok, ancestry: anc({ status: "identical" }) }), null);
  assert.equal(validateTarget({ ...ok, ancestry: anc({ status: "diverged" }) }), "replacement_ancestry_unproven");
  assert.equal(validateTarget({ ...ok, ancestry: anc({ status: "behind" }) }), "replacement_ancestry_unproven");
  assert.equal(validateTarget({ ...ok, ancestry: anc({ baseSha: BASE }) }), "replacement_ancestry_unbound");
  assert.equal(validateTarget({ ...ok, ancestry: anc({ headSha: OLD }) }), "replacement_ancestry_unbound");
  assert.equal(validateTarget({ ...ok, ancestry: undefined }), "replacement_ancestry_unbound");
  assert.equal(validateTarget({ ...ok, superseded: sup({ base: { ref: "main" } }) }), "superseded_wrong_base");
  assert.equal(validateTarget({ ...ok, pr: pr({ base: { ref: "claude/old", sha: BASE } }) }), "base_not_integration_target");
  assert.equal(validateTarget({ ...ok, superseded: sup({ head: { ref: "claude/x", sha: OLD } }) }), "replacement_stack");
  assert.equal(validateTarget({ ...ok, superseded: sup({ head: { ref: "claude/old", sha: "bad" } }) }), "superseded_malformed");
});

test("durable claim/in-flight/adopt/done with persisted simulated records; no duplicate planned dispatch", () => {
  let records = [];
  const p1 = planLifecycle(base({ records }));
  assert.ok(p1.writes.some((w) => w.type === "claim_planned"));
  records = applySimulated(records, p1);
  assert.equal(keyState(records, p1.key).state, "claimed");
  // replay with claim persisted: in-flight, NO planned writes (no duplicate dispatch)
  const p2 = planLifecycle(base({ records }));
  assert.equal(p2.action, "in_flight");
  assert.deepEqual(p2.writes, []);
  // claimed + complete lookup w/ one match -> adopt existing
  const p3 = planLifecycle(base({ records, lookup: { complete: true, matches: [{ ref: 77 }] } }));
  assert.equal(p3.action, "adopt_existing");
  assert.equal(p3.ref, 77);
  assert.ok(!p3.writes.some((w) => /claim_planned|^(review|revise|accept)_planned$/.test(w.type)));
  records = applySimulated(records, p3);
  assert.equal(keyState(records, p1.key).state, "issue");
  // issue record persisted -> adopt + finalize (done), still no new dispatch
  const p4 = planLifecycle(base({ records }));
  assert.equal(p4.action, "adopt_existing");
  assert.deepEqual(p4.writes.map((w) => w.type), ["done_planned"]);
  records = applySimulated(records, p4);
  assert.equal(planLifecycle(base({ records })).reason, "duplicate_key_done");
  // claimed + ambiguous recovery
  const c = [rec(p1.key, "claimed")];
  assert.equal(planLifecycle(base({ records: c, lookup: { complete: false, matches: [] } })).reason, "ambiguous_post_lookup_incomplete");
  assert.equal(planLifecycle(base({ records: c, lookup: { complete: true, matches: [{ ref: 1 }, { ref: 2 }] } })).reason, "ambiguous_post_duplicate_matches");
  assert.equal(planLifecycle(base({ records: c, lookup: { complete: true, matches: [] } })).reason, "ambiguous_post_not_found_manual_retry");
});

test("conflicting / forged / malformed records", () => {
  const k = K("accept");
  assert.equal(planLifecycle(base({ records: [rec(k, "issue", 1), rec(k, "done", 2)] })).reason, "record_conflict");
  assert.equal(planLifecycle(base({ records: [rec(k, "issue")] })).reason, "record_conflict");
  assert.equal(planLifecycle(base({ records: [rec(k, "done", undefined, MAL)] })).action, "plan", "forged done ignored");
  assert.equal(planLifecycle(base({ records: [rec(k, "done", undefined, { ...WRITER, type: "User" })] })).action, "plan");
  assert.equal(keyState([{ user: WRITER, body: "<!-- orch-record:orch:v1:req1:pr1:bogus:r1 state=done -->" }], "x").state, "none");
});

test("completion/blocked events dedupe across rounds and PR replacement", () => {
  assert.equal(eventPlan({ kind: "complete", req: 136, pr: 9, round: 1 }).action, "emit_event");
  const done = [rec(K("complete", 1, 9), "done")];
  assert.equal(eventPlan({ kind: "complete", req: 136, pr: 9, round: 1, existing: done }).reason, "event_already_recorded");
  assert.equal(eventPlan({ kind: "complete", req: 136, pr: 12, round: 3, existing: done }).reason, "event_already_recorded", "replacement PR + later round");
  assert.equal(eventPlan({ kind: "complete", req: 137, pr: 9, round: 1, existing: done }).action, "emit_event", "other request");
  const b = [rec(K("blocked", 1, 9), "done")];
  assert.equal(eventPlan({ kind: "blocked", req: 136, pr: 12, round: 1, existing: b }).reason, "event_already_recorded");
  assert.equal(eventPlan({ kind: "blocked", req: 136, pr: 9, round: 2, existing: b }).action, "emit_event", "new round may block again");
  assert.equal(eventPlan({ kind: "blocked", req: 136, pr: 9, round: 1, existing: [rec(K("blocked"), "done", undefined, MAL)] }).action, "emit_event");
});

test("ambiguous POST recovery fails closed", () => {
  const key = K("revise");
  assert.equal(recoverAmbiguousPost({ key, lookup: undefined }).action, "blocked");
  assert.equal(recoverAmbiguousPost({ key, lookup: { complete: true } }).action, "blocked");
  assert.equal(recoverAmbiguousPost({ key, lookup: { complete: true, matches: [{ ref: 7 }] } }).ref, 7);
});

test("round cap", () => {
  assert.equal(planLifecycle(base({ round: MAX_ROUNDS + 1 })).reason, "round_cap_exceeded");
  assert.equal(planLifecycle(base({ round: MAX_ROUNDS, reviews: [review({ has_unresolved_findings: true })] })).reason, "round_cap_reached_before_revision");
});

// ---- adapter: real Codex bot payload + existing PM marker format ------------------------------
const codexBody = (sha, unresolved) => `<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 ${JSON.stringify({ code_review: { commit_sha: sha, has_any_findings: unresolved, has_unresolved_findings: unresolved, status: "completed" }, security_review: { commit_sha: null } })} -->\n<details>x</details>`;
test("adapter: real bot payload shape, forged/untrusted/malformed ignored", () => {
  const r = normalizeCodexReviews([{ id: 1, user: BOT, body: codexBody(SHA, false) }, { id: 2, user: OWNER, body: codexBody(SHA, false) }, { id: 3, user: { ...BOT, id: 5 }, body: codexBody(SHA, false) },
    { id: 4, user: BOT, body: "<!-- codex-review-state:v1 {nope} -->" }, { id: 5, user: BOT, body: codexBody("abc", false) }]);
  assert.equal(r.length, 1);
  assert.deepEqual([r[0].trusted, r[0].commit_sha, r[0].has_unresolved_findings], [true, SHA, false]);
  const a = pmAcceptMarkers([{ id: 9, user: OWNER, body: `<!-- gpt-pm-accept:v1 issue136:pr9:${SHA}:target=${T} -->` }, { id: 10, user: MAL, body: `<!-- gpt-pm-accept:v1 issue136:pr9:${SHA}:target=${T} -->` },
    { id: 11, user: OWNER, body: `<!-- gpt-pm-accept:v1 issue136:pr9:abc:target=${T} -->` }]);
  assert.deepEqual(a, [{ issue: 136, pr: 9, sha: SHA, target: T, commentId: 9 }]);
});

// ---- ACTUAL entrypoint (handle) with fixture HTTP: dry-run only, read-only, no writes -----------
function fixtureFetch(world, calls) {
  return async (url, init) => {
    const u = new URL(url); const path = u.pathname.replace("/repos/o/r", ""); calls.push(`${init.method} ${path}`);
    const j = (b) => ({ ok: true, status: 200, json: async () => b });
    let m;
    if (path === "/pulls/9") return j(world.pr);
    if (path === "/issues/9/comments") return j(world.comments);
    if (path === "/issues/136") return j({ number: 136, labels: [{ name: "agent:claude" }] });
    if ((m = /^\/commits\/(\w+)$/.exec(path))) return j({ sha: m[1], parents: world.parents });
    if (path.startsWith("/branches/")) return j({ commit: { sha: world.tip } });
    if ((m = /^\/compare\/(\w+)\.\.\.(\w+)$/.exec(path))) return j({ status: world.cmp(m[1], m[2]) });
    if (path.endsWith("/check-runs")) return j({ check_runs: world.checks });
    if (path === "/deployments") return j(world.deployments);
    if (/^\/deployments\/\d+\/statuses$/.test(path)) return j([{ state: "success" }]);
    return { ok: false, status: 404, json: async () => ({}) };
  };
}
const ENV = { HANDOFF_LIFECYCLE_ALLOWLIST: T, HANDOFF_LIFECYCLE_EXPECTED_BASE: BASE };
async function entry(world, env = ENV, event = ["workflow_dispatch", { inputs: { pr: "9" } }]) {
  const calls = [], lines = [];
  const gh = createClient({ token: "t", repo: "o/r", fetchImpl: fixtureFetch(world, calls), sleep: async () => {} });
  await handle({ name: event[0], payload: event[1], gh, apply: false, repo: "o/r", env, out: (o) => lines.push(o) });
  return { calls, lines, lifecycle: lines.find((l) => l.lifecycle)?.lifecycle };
}
const baseWorld = (x = {}) => ({ pr: { ...pr({ body: "Refs #136", created_at: "2026-11-16T00:00:00Z" }) }, comments: [{ id: 1, user: BOT, body: codexBody(SHA, false), created_at: "2026-11-16T01:00:00Z", updated_at: "2026-11-16T01:00:00Z" }], parents: [{}, {}], tip: MERGE, cmp: () => "ahead", checks: [], deployments: [], ...x });

test("entrypoint dry-run: open PR -> lifecycle plan from real fixtures, GET-only, live:false", async () => {
  const { calls, lifecycle } = await entry(baseWorld());
  assert.equal(lifecycle.mode, "dry-run"); assert.equal(lifecycle.live, false);
  assert.equal(lifecycle.step, "accept"); assert.equal(lifecycle.why, "awaiting_pm_acceptance_on_exact_sha");
  assert.ok(calls.every((c) => c.startsWith("GET ")), calls.join(","));
});

test("entrypoint dry-run: merged PR uses merge SHA evidence; eligible evidence, completion withheld", async () => {
  const w = baseWorld({ pr: { ...mergedPr({ body: "Refs #136" }) }, checks: [{ head_sha: MERGE, status: "completed", conclusion: "success" }], deployments: [{ id: 5, sha: MERGE, environment: "dev", created_at: "2026-11-16T03:00:00Z" }],
    comments: [{ id: 1, user: BOT, body: codexBody(SHA, false) }, { id: 2, user: OWNER, body: `<!-- gpt-pm-accept:v1 issue136:pr9:${SHA}:target=${T} -->` }] });
  const { calls, lifecycle } = await entry(w);
  assert.equal(lifecycle.phase, "merged"); assert.equal(lifecycle.mergeSha, MERGE);
  assert.equal(lifecycle.evidenceEligible, true); assert.equal(lifecycle.completion, "withheld");
  assert.ok(calls.every((c) => c.startsWith("GET ")));
  // merge SHA != head and CI on head only -> not eligible
  const w2 = { ...w, checks: [{ head_sha: MERGE, status: "completed", conclusion: "failure" }] };
  assert.equal((await entry(w2)).lifecycle.why, "integration_ci_not_green_on_merge_sha");
  // squash-style single-parent merge -> ancestry unproven
  assert.equal((await entry({ ...w, parents: [{}] })).lifecycle.why, "head_ancestry_unproven_squash_or_rebase");
});

test("entrypoint dry-run: missing/malformed config, bad req, and API errors fail closed", async () => {
  assert.equal((await entry(baseWorld(), {})).lifecycle.reason, "config_allowlist_missing");
  assert.equal((await entry(baseWorld(), { ...ENV, HANDOFF_LIFECYCLE_EXPECTED_BASE: "abc" })).lifecycle.reason, "config_expected_base_invalid");
  assert.equal((await entry(baseWorld({ pr: { ...pr({ body: "no link" }) } }))).lifecycle.reason, "req_unresolvable");
  assert.equal((await entry(baseWorld({ pr: { ...pr({ body: "Refs #136", base: { ref: "main", sha: BASE } }) } }))).lifecycle.reason, "integration_target_not_allowlisted");
  assert.equal((await entry(baseWorld({ comments: [] }))).lifecycle.reason, "head_mismatch", "no trusted review -> no expected head -> fail closed");
});

test("entrypoint: apply mode never runs the lifecycle planner", async () => {
  const calls = [], lines = [];
  const gh = createClient({ token: "t", repo: "o/r", fetchImpl: fixtureFetch(baseWorld(), calls), sleep: async () => {} });
  await handle({ name: "workflow_dispatch", payload: { inputs: { pr: "9" } }, gh, apply: true, repo: "o/r", env: ENV, out: (o) => lines.push(o) }).catch(() => {});
  assert.ok(!lines.some((l) => l.lifecycle));
});
