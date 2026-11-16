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
const TIP = H("e");
const tipOk = (x = {}) => ({ sha: TIP, cmp: { baseSha: BASE, headSha: TIP, status: "ahead", ...x } });
const BOT = { login: CODEX_BOT.login, id: CODEX_BOT.id, type: "Bot" };
const OWNER = { login: "jonghee1998", id: 129052128, type: "User" };
const WRITER = { login: "github-actions[bot]", id: 1, type: "Bot" };
const MAL = { login: "mallory", id: 6, type: "User" };
const pr = (x = {}) => ({ number: 9, state: "open", merged: false, user: OWNER, head: { ref: "claude/x", sha: SHA }, base: { ref: T, sha: BASE }, ...x });
const mergedPr = (x = {}) => pr({ state: "closed", merged: true, merge_commit_sha: MERGE, ...x });
const review = (x = {}) => ({ trusted: true, user: BOT, commit_sha: SHA, status: "completed", has_unresolved_findings: false, ...x });
const acc = (x = {}) => ({ issue: 136, pr: 9, sha: SHA, target: T, ...x });
const base = (x = {}) => ({ req: 136, round: 1, config: CFG, integrationTarget: T, pr: pr(), expectedHead: SHA, reviews: [review()], pmAccepts: [], pmRevises: [], records: [], tip: tipOk(), ...x });
const mergedBase = (x = {}) => base({ pr: mergedPr(), reviews: [review()], pmAccepts: [acc()],
  merge: { sha: MERGE, tipContainsMerge: true, headContained: true }, ci: { sha: MERGE, status: "success" }, deployment: { sha: MERGE, source: "vercel_commit_status", status: "success" }, ...x });
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
  assert.equal(parseConfig({ allowlist: [T] }).ok, true, "F1: no hardcoded base SHA is required");
  for (const bad of [undefined, {}, { allowlist: [], expectedBase: BASE }, { allowlist: ["main"], expectedBase: BASE }, { allowlist: ["codex/*"], expectedBase: BASE },
    { allowlist: [T], expectedBase: "abc" }, { allowlist: [T], expectedBase: BASE.toUpperCase() }, { allowlist: [5], expectedBase: BASE }, { allowlist: ["a/../b"], expectedBase: BASE }]) {
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
  assert.equal(planLifecycle(mergedBase({ deployment: { sha: SHA, source: "vercel_commit_status", status: "success" } })).why, "dev_deployment_not_proven_on_merge_sha");
  assert.equal(planLifecycle(mergedBase({ deployment: { sha: MERGE, source: "github_deployment_production", status: "success" } })).why, "dev_deployment_not_proven_on_merge_sha");
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
  assert.equal(planLifecycle(base({ pr: pr({ base: { ref: T, sha: "bad" } }) })).reason, "base_mismatch");
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
// #144: markers are explicit now. Fixture PRs get `supersedes none` unless they already carry a supersedes marker (or rawBody).
const withMarker = (p, raw) => (raw || /orch-supersedes:v1/.test(p?.body ?? "") ? p : { ...p, body: `${p?.body ?? ""}\n<!-- orch-supersedes:v1 none -->` });
function fixtureFetch(world, calls) {
  return async (url, init) => {
    const u = new URL(url); const path = u.pathname.replace("/repos/o/r", ""); calls.push(`${init.method} ${path}`);
    const j = (b) => ({ ok: true, status: 200, json: async () => b });
    let m;
    if (path === "/pulls/9") return j(withMarker(world.pr, world.rawBody));
    if ((m = /^\/issues\/(\d+)\/comments$/.exec(path))) return j(world.commentsBy?.[m[1]] ?? (m[1] === "9" ? world.comments : []));
    if ((m = /^\/issues\/(\d+)$/.exec(path))) return j(world.issues?.[m[1]] ?? { number: Number(m[1]), user: OWNER, labels: [{ name: "agent:claude" }], body: `<!-- orch-root-request:v1 #${m[1]} -->` });
    if ((m = /^\/commits\/(\w+)$/.exec(path))) return j({ sha: m[1], parents: world.parents });
    if (path.startsWith("/branches/")) return j({ commit: { sha: world.tip } });
    if ((m = /^\/compare\/(\w+)\.\.\.(\w+)$/.exec(path))) return j({ status: world.cmp(m[1], m[2]) });
    if (path.endsWith("/check-runs")) return j({ total_count: world.checks.length, check_runs: world.checks });
    if ((m = /^\/commits\/(\w+)\/status$/.exec(path))) return j(world.status(m[1]));
    if (path.startsWith("/pulls/")) { const x = world.pulls?.[path.slice(7)]; if (x) return j(withMarker(x, world.rawBody)); }
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
const vercel = (sha, state = "success") => ({ sha, total_count: 2, statuses: [{ context: "Vercel", state, updated_at: "2026-11-16T03:00:00Z" }, { context: "Vercel Preview Comments", state: "success", updated_at: "2026-11-16T03:00:00Z" }] });
const baseWorld = (x = {}) => ({ pr: { ...pr({ body: "Refs #136", created_at: "2026-11-16T00:00:00Z" }) }, comments: [{ id: 1, user: BOT, body: codexBody(SHA, false), created_at: "2026-11-16T01:00:00Z", updated_at: "2026-11-16T01:00:00Z" }], parents: [{}, {}], tip: MERGE, cmp: () => "ahead", checks: [], status: (sha) => ({ sha, total_count: 0, statuses: [] }), ...x });

test("entrypoint dry-run: open PR -> lifecycle plan from real fixtures, GET-only, live:false", async () => {
  const { calls, lifecycle } = await entry(baseWorld());
  assert.equal(lifecycle.mode, "dry-run"); assert.equal(lifecycle.live, false);
  assert.equal(lifecycle.step, "accept"); assert.equal(lifecycle.why, "awaiting_pm_acceptance_on_exact_sha");
  assert.ok(calls.every((c) => c.startsWith("GET ")), calls.join(","));
});

test("entrypoint dry-run: merged PR uses merge SHA evidence; eligible evidence, completion withheld", async () => {
  const w = baseWorld({ pr: { ...mergedPr({ body: "Refs #136" }) }, checks: [{ head_sha: MERGE, status: "completed", conclusion: "success" }], status: (sha) => vercel(sha),
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

// ================= Issue #141 regression tests (Opus F1-F8 on PR139) =================
import { ciFromCheckRuns, deploymentFromCommitStatus, rootMarker, supersedesMarker } from "./lifecycle-evidence.mjs";
import { manualInvocation } from "./main.mjs";
import { readFileSync } from "node:fs";
const TIP2 = H("f");

test("F1: open PR base only needs to be an ancestor of the LIVE tip; no hardcoded SHA; tip movement tolerated", () => {
  const p = planLifecycle(base({ pr: pr({ base: { ref: T, sha: OLD } }), tip: { sha: TIP2, cmp: { baseSha: OLD, headSha: TIP2, status: "ahead" } } }));
  assert.equal(p.action, "plan", "base behind a moved tip is fine");
  assert.equal(planLifecycle(base({ tip: tipOk({ status: "identical" }) })).action, "plan");
  assert.equal(planLifecycle(base({ tip: tipOk({ status: "diverged" }) })).reason, "base_not_ancestor_of_tip");
  assert.equal(planLifecycle(base({ tip: tipOk({ status: "behind" }) })).reason, "base_not_ancestor_of_tip");
  assert.equal(planLifecycle(base({ tip: tipOk({ status: "unknown" }) })).reason, "base_tip_unverified");
  assert.equal(planLifecycle(base({ tip: undefined })).reason, "base_tip_unverified");
  assert.equal(planLifecycle(base({ tip: tipOk({ baseSha: OLD }) })).reason, "base_tip_unverified", "compare must echo pr.base.sha");
  assert.equal(planLifecycle(base({ tip: { sha: TIP, cmp: { baseSha: BASE, headSha: TIP2, status: "ahead" } } })).reason, "base_tip_unverified", "compare must echo the tip sha");
  assert.equal(parseConfig({ allowlist: [T], expectedBase: "zz" }).ok, false, "a malformed optional base is still a config error");
  const wf = readFileSync(new URL("../../.github/workflows/handoff-coordinator.yml", import.meta.url), "utf8");
  assert.ok(!/HANDOFF_LIFECYCLE_EXPECTED_BASE/.test(wf) && !/[a-f0-9]{40}/.test(wf), "workflow carries no hardcoded SHA");
});

test("F1 entrypoint: integration branch tip moved after PR was opened -> still planned; diverged tip fails closed", async () => {
  const moved = baseWorld({ tip: TIP2, cmp: (a, b) => (a === BASE && b === TIP2 ? "ahead" : "ahead") });
  assert.equal((await entry(moved)).lifecycle.action, "plan");
  const forced = baseWorld({ tip: TIP2, cmp: () => "diverged" });
  assert.equal((await entry(forced)).lifecycle.reason, "base_not_ancestor_of_tip");
  const unknown = baseWorld({ tip: "nothex", cmp: () => "ahead" });
  assert.equal((await entry(unknown)).lifecycle.reason, "base_tip_unverified");
});

test("F2: workflow documents default-branch limits, has a pull_request dry-run route, apply never from PR events; manual --pr is dry-run only", () => {
  const wf = readFileSync(new URL("../../.github/workflows/handoff-coordinator.yml", import.meta.url), "utf8");
  assert.match(wf, /pull_request:\s*\n\s*#[^\n]*\n\s*branches: \[codex\/issue-92-mobile-v2\]/);
  assert.match(wf, /github\.event_name == 'issue_comment' \|\| github\.event_name == 'workflow_dispatch'\)/, "apply only from default-branch triggers");
  assert.ok(!/deployments:/.test(wf));
  assert.ok(!/pull_request_target/.test(wf));
  assert.deepEqual(manualInvocation(["node", "main.mjs", "--pr", "139"]), { name: "workflow_dispatch", payload: { inputs: { pr: "139" } } });
  assert.equal(manualInvocation(["node", "main.mjs"]), null);
  assert.throws(() => manualInvocation(["node", "main.mjs", "--pr", "1", "--apply"]), /dry-run only/);
  assert.throws(() => manualInvocation(["node", "main.mjs", "--pr", "x"]));
});

test("F2 entrypoint: pull_request event (same repo) runs the lifecycle dry-run, fork PR is skipped", async () => {
  const w = baseWorld();
  const ev = (full) => ["pull_request", { pull_request: { number: 9, head: { sha: SHA, repo: { full_name: full } }, base: { repo: { full_name: "o/r" } } } }];
  const ok = await entry(w, ENV, ev("o/r"));
  assert.equal(ok.lifecycle.action, "plan");
  assert.ok(ok.calls.every((c) => c.startsWith("GET ")));
  const fork = await entry(w, ENV, ev("evil/r"));
  assert.equal(fork.lifecycle, undefined);
  assert.equal(fork.lines[0].reason, "fork_or_unknown_pull_request");
});

const rootIssue = (n, root = n) => ({ number: n, user: OWNER, labels: [], body: `<!-- orch-root-request:v1 #${root} -->` });
test("F3: root request marker (trusted author only), unmarked issue is its own root", () => {
  assert.equal(rootMarker(rootIssue(138, 136)), 136);
  assert.equal(rootMarker(rootIssue(136)), 136, "root carries an explicit self marker");
  assert.equal(rootMarker({ user: OWNER, body: "root" }), null, "#144: no marker => null (callers fail closed, no implicit self-root)");
  assert.equal(rootMarker({ ...rootIssue(138, 136), user: MAL }), null, "untrusted author ignored");
  assert.equal(rootMarker({ user: OWNER, body: "<!-- orch-root-request:v1 #1 --><!-- orch-root-request:v1 #2 -->" }), "ambiguous");
});

test("F3 entrypoint: replacement PR (closes revision #138) uses root #136 records + rounds, cap enforced across PRs", async () => {
  const issues = { 138: rootIssue(138, 136), 136: rootIssue(136) };
  const revDone = (r, p) => rec(orchKey({ req: 136, pr: p, step: "revise", round: r }), "done", 100 + r);
  const w = (rootComments) => baseWorld({ pr: pr({ body: "Closes #138", created_at: "2026-11-16T00:00:00Z" }), issues, commentsBy: { 136: rootComments } });
  const r1 = (await entry(w([]))).lifecycle;
  assert.equal(r1.key, "orch:v1:req136:pr9:accept:r1", "keyed by ROOT request, not the revision issue");
  // two rounds already closed out on earlier PRs (root issue comments) -> this PR is round 3
  const r3 = (await entry(w([revDone(1, 7), revDone(2, 8)]))).lifecycle;
  assert.equal(r3.key, "orch:v1:req136:pr9:accept:r3");
  // three closed rounds -> cap exceeded across the replacement chain
  assert.equal((await entry(w([revDone(1, 7), revDone(2, 8), revDone(3, 9)]))).lifecycle.reason, "round_cap_exceeded");
  // PM accept by root issue number is honoured on the replacement PR
  const acceptRoot = baseWorld({ pr: pr({ body: "Closes #138", created_at: "x" }), issues, comments: [{ id: 1, user: BOT, body: codexBody(SHA, false) }, { id: 2, user: OWNER, body: `<!-- gpt-pm-accept:v1 issue136:pr9:${SHA}:target=${T} -->` }] });
  assert.equal((await entry(acceptRoot)).lifecycle.why, "review_accepted_awaiting_merge_and_integration_evidence");
  // cycle / ambiguity fail closed
  assert.equal((await entry(baseWorld({ pr: pr({ body: "Closes #138" }), issues: { 138: rootIssue(138, 139), 139: rootIssue(139, 138) } }))).lifecycle.reason, "root_not_self_marked", "cycle never terminates in a self-marked root");
});

test("F3: eventPlan is integrated: complete once per request across PR chain, blocked once per request+round", () => {
  const done = [rec(K("complete", 1, 7), "done")];
  const p = planLifecycle(mergedBase({ records: done, pr: mergedPr({ number: 9 }) }));
  assert.equal(p.reason, "event_already_recorded");
  assert.equal(planLifecycle(mergedBase()).event.action, "emit_event");
  const blk = planLifecycle(base({ round: 2, reviews: [review({ has_unresolved_findings: true })], pr: pr({ head: { ref: "x", sha: SHA } }), tip: undefined }));
  assert.equal(blk.action, "blocked");
  assert.equal(blk.event.action, "emit_event");
  const again = planLifecycle(base({ round: 2, tip: undefined, records: [rec(K("blocked", 2, 7), "done")] }));
  assert.equal(again.event.reason, "event_already_recorded", "other PR in chain already recorded this blocked round");
  assert.deepEqual(again.writes, []);
});

test("F4: check-runs total_count incomplete fails closed; all-skipped is not green", () => {
  const run = (c, s = "completed") => ({ head_sha: MERGE, status: s, conclusion: c });
  assert.equal(ciFromCheckRuns(MERGE, { total_count: 1, check_runs: [run("success")] }).status, "success");
  assert.equal(ciFromCheckRuns(MERGE, { total_count: 101, check_runs: [run("success")] }).status, "incomplete");
  assert.equal(ciFromCheckRuns(MERGE, { check_runs: [run("success")] }).status, "incomplete", "total_count absent");
  assert.equal(ciFromCheckRuns(MERGE, { total_count: 2, check_runs: [run("skipped"), run("skipped")] }).status, "all_skipped");
  assert.equal(ciFromCheckRuns(MERGE, { total_count: 2, check_runs: [run("skipped"), run("neutral")] }).status, "all_skipped");
  assert.equal(ciFromCheckRuns(MERGE, { total_count: 2, check_runs: [run("success"), run("skipped")] }).status, "success");
  assert.equal(ciFromCheckRuns(MERGE, { total_count: 0, check_runs: [] }).status, "missing");
  assert.equal(planLifecycle(mergedBase({ ci: { sha: MERGE, status: "incomplete" } })).why, "integration_ci_not_green_on_merge_sha");
  assert.equal(planLifecycle(mergedBase({ ci: { sha: MERGE, status: "all_skipped" } })).completion, "withheld");
});

test("F5: dev deployment evidence = Vercel commit status on the exact SHA; missing/incomplete/other sha withheld", () => {
  assert.equal(deploymentFromCommitStatus(MERGE, vercel(MERGE)).status, "success");
  assert.equal(deploymentFromCommitStatus(MERGE, vercel(MERGE, "pending")).status, "pending");
  assert.equal(deploymentFromCommitStatus(MERGE, vercel(SHA)).status, "malformed", "payload for another SHA");
  assert.equal(deploymentFromCommitStatus(MERGE, { sha: MERGE, total_count: 150, statuses: vercel(MERGE).statuses }).status, "incomplete");
  assert.equal(deploymentFromCommitStatus(MERGE, { sha: MERGE, total_count: 1, statuses: [{ context: "Vercel Preview Comments", state: "success" }] }).status, "missing", "other contexts are not deployment evidence");
  assert.equal(deploymentFromCommitStatus(MERGE, undefined).status, "missing");
  // a stale success must not mask a newer failure
  const s2 = { sha: MERGE, total_count: 2, statuses: [{ context: "Vercel", state: "success", updated_at: "2026-11-16T01:00:00Z" }, { context: "Vercel", state: "failure", updated_at: "2026-11-16T02:00:00Z" }] };
  assert.equal(deploymentFromCommitStatus(MERGE, s2).status, "failure");
  assert.equal(planLifecycle(mergedBase({ deployment: { sha: MERGE, source: "vercel_commit_status", status: "pending" } })).why, "dev_deployment_not_proven_on_merge_sha");
  assert.equal(planLifecycle(mergedBase({ deployment: { sha: MERGE, env: "dev", status: "success" } })).why, "dev_deployment_not_proven_on_merge_sha", "an assumed GitHub env 'dev' is not accepted");
});

test("F5 entrypoint: merged PR without Vercel status stays withheld; with it, eligible", async () => {
  const w = baseWorld({ pr: mergedPr({ body: "Refs #136" }), checks: [{ head_sha: MERGE, status: "completed", conclusion: "success" }],
    comments: [{ id: 1, user: BOT, body: codexBody(SHA, false) }, { id: 2, user: OWNER, body: `<!-- gpt-pm-accept:v1 issue136:pr9:${SHA}:target=${T} -->` }] });
  assert.equal((await entry(w)).lifecycle.why, "dev_deployment_not_proven_on_merge_sha");
  const ok = (await entry({ ...w, status: (s) => vercel(s) })).lifecycle;
  assert.equal(ok.evidenceEligible, true); assert.equal(ok.completion, "withheld");
  assert.equal((await entry({ ...w, checks: [{ head_sha: MERGE, status: "completed", conclusion: "skipped" }], status: (s) => vercel(s) })).lifecycle.why, "integration_ci_not_green_on_merge_sha");
});

test("F6: done record without a ref is ambiguous for issue-creating steps (events may omit it)", () => {
  const k = K("revise");
  assert.equal(keyState([rec(k, "done")], k).state, "ambiguous");
  assert.equal(keyState([rec(k, "done")], k).why, "done_without_ref");
  assert.equal(keyState([rec(k, "done", 5)], k).state, "done");
  assert.equal(keyState([rec(k, "claimed"), rec(k, "done", 5)], k).ref, 5);
  assert.equal(keyState([rec(K("complete"), "done")], K("complete")).state, "done", "event steps carry no ref");
  assert.equal(planLifecycle(base({ records: [rec(K("accept"), "done")] })).reason, "record_conflict");
});

test("F7: lifecycle diagnostic is emitted even when the legacy run throws; the error still propagates (fail closed)", async () => {
  const lines = [];
  const world = baseWorld();
  const calls = [];
  let n = 0;
  const base_ = fixtureFetch(world, calls);
  // legacy run() reads /issues/136 via getIssue; fail only the first comments read (legacy path), lifecycle then proceeds.
  const fetchImpl = async (url, init) => (new URL(url).pathname.endsWith("/issues/9/comments") && n++ === 0 ? { ok: false, status: 404, json: async () => ({}) } : base_(url, init));
  const gh = createClient({ token: "t", repo: "o/r", fetchImpl, sleep: async () => {} });
  await assert.rejects(handle({ name: "workflow_dispatch", payload: { inputs: { pr: "9" } }, gh, apply: false, repo: "o/r", env: ENV, out: (o) => lines.push(o) }), /404/);
  assert.ok(lines.some((l) => l.result === "legacy_run_failed"));
  const lc = lines.find((l) => l.lifecycle)?.lifecycle;
  assert.ok(lc && lc.live === false && lc.mode === "dry-run", "lifecycle diagnostic present");
});

test("F8: superseded PR is loaded by the real entrypoint and ancestry is verified (replacement chain)", async () => {
  const supPr = { number: 7, user: OWNER, body: "Closes #136", state: "closed", merged: false, base: { ref: T, sha: BASE }, head: { ref: "claude/old", sha: OLD } };
  const w = (cmp, extra = {}) => baseWorld({ pr: pr({ body: "Refs #136\n<!-- orch-supersedes:v1 pr7 -->", created_at: "x" }), pulls: { 7: supPr }, cmp, ...extra });
  const good = (a, b) => (a === OLD && b === SHA ? "ahead" : "ahead");
  const r = await entry(w(good));
  assert.equal(r.lifecycle.action, "plan");
  assert.ok(r.calls.includes(`GET /pulls/7`) && r.calls.some((c) => c.includes(`/compare/${OLD}...${SHA}`)), "real entrypoint fetched superseded PR + compared exact SHAs");
  assert.equal((await entry(w((a, b) => (a === OLD && b === SHA ? "diverged" : "ahead")))).lifecycle.reason, "replacement_ancestry_unproven");
  assert.equal((await entry(w((a, b) => (a === OLD && b === SHA ? "behind" : "ahead")))).lifecycle.reason, "replacement_ancestry_unproven");
  assert.equal((await entry(w(good, { pulls: { 7: { ...supPr, merged: true, state: "closed" } } }))).lifecycle.reason, "superseded_merged");
  assert.equal((await entry(w(good, { pulls: { 7: { ...supPr, base: { ref: "main", sha: BASE } } } }))).lifecycle.reason, "superseded_wrong_base");
  assert.equal((await entry(w(good, { pulls: { 7: { ...supPr, head: { ref: "claude/x", sha: OLD } } } }))).lifecycle.reason, "replacement_stack");
  assert.equal((await entry(baseWorld({ pr: pr({ body: "Refs #136\n<!-- orch-supersedes:v1 pr7 --><!-- orch-supersedes:v1 pr8 -->", created_at: "x" }) }))).lifecycle.reason, "supersedes_ambiguous");
  assert.equal(supersedesMarker({ user: MAL, body: "<!-- orch-supersedes:v1 pr7 -->" }), null, "untrusted marker ignored");
  assert.equal(supersedesMarker({ user: OWNER, body: "no marker" }), null);
});

// ================= Issue #144: explicit root / supersedes markers, chain-derived round cap =================
// REAL bodies as they exist on GitHub today (markers absent): Issue #141 and PR142 (only the parts that matter to parsing).
const REAL_141 = { number: 141, user: OWNER, labels: [], body: "Completion type: integration\nIntegration target: codex/issue-92-mobile-v2\nGPT review ... This is T5 revision round 2 (root request #136; prior revision #138). Start replacement branch FROM PR139 exact head, direct PR to integration; preserve all prior changes." };
const REAL_PR142_BODY = "Closes #141. Root request #136; prior revision #138 / PR139 (head 59ad3031159f78589f0c49f29bc35e8f327104e9, preserved as parent). Replacement branch started from that exact head, PR directly to the integration branch.\n\n- F3: canonical root request via `orch-root-request:v1` marker; records and rounds read across the chain.\n- F8: superseded PR and ancestry loaded and verified by the real entrypoint (`orch-supersedes:v1` marker).";
const ROOT = (n, root = 136) => ({ number: n, user: OWNER, labels: [], body: `Completion type: integration\n<!-- orch-root-request:v1 #${root} -->` });
const PRX = (number, body, headSha, ref, extra = {}) => ({ number, user: OWNER, state: "open", merged: false, body, head: { ref, sha: headSha }, base: { ref: T, sha: BASE }, ...extra });
const H139 = H("3"), H142 = H("4"), H137 = H("7");
// Corrected chain as it must look on GitHub: PR(new, #144) -> PR142 (#141) -> PR139 (#138) -> PR137 (#136), all root #136.
const chainWorld = (x = {}) => {
  const pulls = {
    142: PRX(142, "Closes #141\n<!-- orch-supersedes:v1 pr139 -->", H142, "claude/r142"),
    139: PRX(139, "Closes #138\n<!-- orch-supersedes:v1 pr137 -->", H139, "claude/r139"),
    137: PRX(137, "Closes #136\n<!-- orch-supersedes:v1 none -->", H137, "claude/r137"),
  };
  const issues = { 136: ROOT(136), 138: ROOT(138), 141: ROOT(141), 144: ROOT(144) };
  return baseWorld({ pr: pr({ body: "Closes #144\n<!-- orch-supersedes:v1 pr142 -->" }), issues, pulls, ...x });
};

test("#144: markers parse strictly: supersedes pr<N> | none; missing/untrusted => null, repeated different => ambiguous", () => {
  assert.equal(supersedesMarker({ user: OWNER, body: "<!-- orch-supersedes:v1 pr142 -->" }), 142);
  assert.equal(supersedesMarker({ user: OWNER, body: "<!-- orch-supersedes:v1 none -->" }), "none");
  assert.equal(supersedesMarker({ user: OWNER, body: "<!-- orch-supersedes:v1 none --><!-- orch-supersedes:v1 pr1 -->" }), "ambiguous");
  assert.equal(supersedesMarker({ user: OWNER, body: "<!-- orch-supersedes:v1 pr1 --><!-- orch-supersedes:v1 pr1 -->" }), 1, "identical repeat is not ambiguous");
  assert.equal(supersedesMarker({ user: MAL, body: "<!-- orch-supersedes:v1 none -->" }), null);
  assert.equal(supersedesMarker({ user: OWNER, body: "supersedes none" }), null);
  assert.equal(supersedesMarker({ user: OWNER, body: REAL_PR142_BODY }), null, "real PR142 body: prose mentions are not markers");
});

test("#144: ACTUAL #141 / PR142 bodies (markers missing) are blocked, never silently req141 / skipped ancestry", async () => {
  // PR142 as it exists today, linked issue #141 as it exists today.
  const w = baseWorld({ rawBody: true, pr: pr({ body: REAL_PR142_BODY }), issues: { 141: REAL_141 } });
  const r = (await entry(w)).lifecycle;
  assert.equal(r.action, "blocked"); assert.equal(r.reason, "root_marker_missing"); assert.deepEqual(r.detail, { linked: 141, issue: 141 });
  assert.equal(r.live, false); assert.deepEqual(r.writes, []);
  // root marker present on #141 but PR142 still has no supersedes marker => still blocked, ancestry not skipped
  const w2 = { ...w, issues: { 141: ROOT(141), 136: ROOT(136) } };
  assert.equal((await entry(w2)).lifecycle.reason, "supersedes_marker_missing");
  // root named by the revision issue does not itself carry a self marker => blocked
  assert.equal((await entry({ ...w2, pr: pr({ body: `${REAL_PR142_BODY}\n<!-- orch-supersedes:v1 none -->` }), rawBody: true, issues: { 141: ROOT(141), 136: { number: 136, user: OWNER, body: "root" } } })).lifecycle.reason, "root_not_self_marked");
  // untrusted author's markers do not count
  assert.equal((await entry({ ...w2, issues: { 141: { ...ROOT(141), user: MAL } } })).lifecycle.reason, "root_marker_missing");
  // ambiguous root markers
  assert.equal((await entry({ ...w2, issues: { 141: { ...ROOT(141), body: "<!-- orch-root-request:v1 #136 --><!-- orch-root-request:v1 #138 -->" } } })).lifecycle.reason, "root_request_ambiguous");
});

test("#144: corrected markers => req136 round 3, PR142 ancestry validated by the real entrypoint (cap not reset)", async () => {
  const w = chainWorld();
  const { lifecycle: p, calls } = await entry(w);
  assert.equal(p.action, "plan");
  assert.equal(p.key, "orch:v1:req136:pr9:accept:r3", "root #136, round 3 = third revision PR in the chain");
  assert.ok(calls.includes("GET /pulls/142") && calls.includes("GET /pulls/139") && calls.includes("GET /pulls/137"), "full chain traversed");
  assert.ok(calls.some((c) => c.includes(`/compare/${H142}...${SHA}`)), "ancestry of the superseded head compared at the exact SHAs");
  assert.ok(calls.every((c) => c.startsWith("GET ")));
  // the SAME corrected PR142 evaluated on its own (head e4721c8 equivalent) is round 2 with PR139 ancestry
  const p142 = (await entry({ ...chainWorld(), pr: PRX(9, "Closes #141\n<!-- orch-supersedes:v1 pr139 -->", SHA, "claude/x") })).lifecycle;
  assert.equal(p142.key, "orch:v1:req136:pr9:accept:r2");
  assert.ok((await entry({ ...chainWorld(), pr: PRX(9, "Closes #141\n<!-- orch-supersedes:v1 pr139 -->", SHA, "claude/x") })).calls.some((c) => c.includes(`/compare/${H139}...${SHA}`)));
  // ancestry failure on the chain's direct predecessor blocks
  assert.equal((await entry(chainWorld({ cmp: (a, b) => (a === H142 && b === SHA ? "diverged" : "ahead") }))).lifecycle.reason, "replacement_ancestry_unproven");
});

test("#144: bot records alone cannot lower the round; chain depth is the floor, records can only raise it", async () => {
  // no durable records at all, chain says round 3
  assert.equal((await entry(chainWorld())).lifecycle.key, "orch:v1:req136:pr9:accept:r3");
  // records on the root issue closing rounds 1-3 raise to the cap-exceeded state
  const revDone = (r) => rec(orchKey({ req: 136, pr: 100 + r, step: "revise", round: r }), "done", 200 + r);
  const w = chainWorld({ commentsBy: { 136: [revDone(1), revDone(2), revDone(3)] } });
  assert.equal((await entry(w)).lifecycle.reason, "round_cap_exceeded");
  // forged records by non-bot accounts never count
  const forged = chainWorld({ commentsBy: { 136: [{ id: 5, user: OWNER, body: recordMarker(orchKey({ req: 136, pr: 101, step: "revise", round: 1 }), "done", 201) }] } });
  assert.equal((await entry(forged)).lifecycle.key, "orch:v1:req136:pr9:accept:r3");
});

test("#144: cap 3 across the chain: round 3 may not dispatch a revision; a 4th revision PR is capped; over-deep chains fail closed", async () => {
  // third revision PR with unresolved findings => no further revision dispatch
  const unresolved = chainWorld({ comments: [{ id: 1, user: BOT, body: codexBody(SHA, true) }] });
  assert.equal((await entry(unresolved)).lifecycle.reason, "round_cap_reached_before_revision");
  // a 4th revision PR (depth 4) => round_cap_exceeded
  const pulls4 = { ...chainWorld().pulls, 143: PRX(143, "Closes #144\n<!-- orch-supersedes:v1 pr142 -->", H("5"), "claude/r143") };
  const w4 = chainWorld({ pr: pr({ body: "Closes #145\n<!-- orch-supersedes:v1 pr143 -->" }), pulls: pulls4, issues: { ...chainWorld().issues, 145: ROOT(145) } });
  const four = (await entry({ ...w4, issues: { ...w4.issues, 144: ROOT(144) } })).lifecycle;
  assert.equal(four.reason, "round_cap_exceeded");
  // chain deeper than the bound is capped without unbounded traversal
  const deep = {}; for (let n = 200; n < 212; n++) deep[n] = PRX(n, `Closes #144\n<!-- orch-supersedes:v1 pr${n + 1} -->`, H("6"), `claude/d${n}`);
  const r = (await entry(chainWorld({ pr: pr({ body: "Closes #144\n<!-- orch-supersedes:v1 pr200 -->" }), pulls: deep }))).lifecycle;
  assert.equal(r.reason, "round_cap_exceeded"); assert.deepEqual(r.detail, { max: MAX_ROUNDS });
});

test("#144: chain members must share the root; cycles and missing links fail closed", async () => {
  const w = chainWorld();
  assert.equal((await entry({ ...w, issues: { ...w.issues, 138: ROOT(138, 150), 150: ROOT(150, 150) } })).lifecycle.reason, "chain_root_mismatch");
  assert.equal((await entry({ ...w, pulls: { ...w.pulls, 139: PRX(139, "Closes #138\n<!-- orch-supersedes:v1 pr142 -->", H139, "claude/r139") } })).lifecycle.reason, "supersedes_cycle");
  assert.equal((await entry({ ...w, pulls: { ...w.pulls, 139: PRX(139, "Closes #138", H139, "claude/r139") }, rawBody: true })).lifecycle.reason, "supersedes_marker_missing", "a chain member without a marker is not assumed to be the original");
  assert.equal((await entry({ ...w, pulls: { ...w.pulls, 139: undefined } })).lifecycle.action, "blocked", "unreadable chain member fails closed");
});

test("#144: workflow stays dry-run, no live/main/prod; note: post-merge CI/deploy re-evaluation is manual (T5 scope)", () => {
  const wf = readFileSync(new URL("../../.github/workflows/handoff-coordinator.yml", import.meta.url), "utf8");
  assert.ok(!/pull_request_target/.test(wf));
  assert.match(wf, /vars\.HANDOFF_COORDINATOR_MODE == 'live'/);
  const doc = readFileSync(new URL("../../docs/HANDOFF_COORDINATOR.md", import.meta.url), "utf8");
  assert.match(doc, /orch-supersedes:v1 none/);
  assert.match(doc, /manual/i);
});
