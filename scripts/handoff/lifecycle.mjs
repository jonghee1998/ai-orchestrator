// Issue #136 (T5) / #138 (T5 revision) — single-writer coordinator lifecycle, DRY-RUN ONLY.
// Pure functions: no network, no GitHub client import, no side effects. The result is a *plan*
// (`mode: "dry-run"`, `live: false`); nothing here dispatches, merges, labels or writes. T6 owns the
// real OFF gate and authenticated approval. Evidence normalization lives in lifecycle-evidence.mjs;
// the dry-run entrypoint wiring lives in lifecycle-run.mjs.
//
// Two evidence phases are modelled separately and never mixed:
//   open_review : PR open, bound to the exact PR head SHA (review / revise / accept).
//   merged      : PR merged into the integration branch, bound to the exact MERGE SHA (ancestry/target,
//                 integration CI, dev deployment). PR head is NOT the CI/deploy subject here.
import { createHash } from "node:crypto";
import { selectReviewVerdict } from "./review-verdict.mjs";

export const KEY_VERSION = "v1";
export const STEPS = Object.freeze(["dispatch", "review", "revise", "accept", "complete", "blocked"]);
export const MAX_ROUNDS = 3;
/** Hard ceiling for an authorized root-specific override (root-corrections.resolveCorrectionLimit). */
export const MAX_ROUNDS_CEILING = 5;
/** Issue #170/#172/#178: the only owner-approved exception (root #146 => 11 per owner standing authorization in #180; no 12th without PM exact-FAIL + authorization). Mirrors root-corrections.ROOT_CEILING_EXCEPTIONS. */
export const MAX_ROUNDS_ROOT_EXCEPTIONS = Object.freeze({ 146: 11 });
export const DEPLOY_SOURCE = "vercel_commit_status";
export const FORBIDDEN_TARGETS = new Set(["main", "master", "production", "prod", "release"]);
const SHA_RE = /^[a-f0-9]{40}$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9_./-]{0,200}$/;
const KEY_RE = /^orch:v1:req(\d+):pr(\d+):(dispatch|review|revise|accept|complete|blocked):r([1-9]\d*)$/;
const WRITER_LOGIN = "github-actions[bot]";

/** Durable claim/issue/done idempotency key: orch:v1:req<N>:pr<P>:<step>:r<n>. Strict; throws on bad input. */
export function orchKey({ req, pr, step, round }) {
  const ok = Number.isInteger(req) && req > 0 && Number.isInteger(pr) && pr > 0 && STEPS.includes(step) && Number.isInteger(round) && round >= 1;
  if (!ok) throw new Error("invalid orch key parts");
  return `orch:${KEY_VERSION}:req${req}:pr${pr}:${step}:r${round}`;
}
export function parseOrchKey(s) {
  const m = KEY_RE.exec(s ?? "");
  return m ? { req: Number(m[1]), pr: Number(m[2]), step: m[3], round: Number(m[4]) } : null;
}

/**
 * Config validation, fail closed. The integration target must be an EXACT member of a configured allowlist
 * (no globs, no forbidden branches). The base is verified against the LIVE branch tip (see validateTarget).
 * @returns {{ok:true, allowlist:string[]} | {ok:false, reason:string}}
 */
export function parseConfig({ allowlist, expectedBase } = {}) {
  if (!Array.isArray(allowlist) || allowlist.length === 0) return { ok: false, reason: "allowlist_missing" };
  for (const b of allowlist) {
    if (typeof b !== "string" || !BRANCH_RE.test(b) || b.includes("..") || /[*?[\]\\]/.test(b)) return { ok: false, reason: "allowlist_malformed" };
    if (FORBIDDEN_TARGETS.has(b.toLowerCase())) return { ok: false, reason: "allowlist_forbidden_branch" };
  }
  // F1 (#141): a hardcoded base SHA goes stale as soon as the integration branch moves, so it is NOT a gate any
  // more. It is optional and, when present, must still be well formed (a malformed value is a config error).
  if (expectedBase !== undefined && expectedBase !== "" && (typeof expectedBase !== "string" || !SHA_RE.test(expectedBase))) return { ok: false, reason: "expected_base_invalid" };
  return { ok: true, allowlist: [...allowlist] };
}

// ---------------------------------------------------------------------------------------------
// Durable records (claim / issue / done), honoured only from the single writer identity.
const RECORD_RE = /<!--\s*orch-record:(orch:v1:req\d+:pr\d+:[a-z]+:r[1-9]\d*)\s+state=(claimed|issue|done)(?:\s+ref=(\d+))?\s*-->/g;
export const recordMarker = (key, state, ref) => `<!-- orch-record:${key} state=${state}${ref ? ` ref=${ref}` : ""} -->`;
const isWriter = (u, login = WRITER_LOGIN) => !!u && u.login === login && u.type === "Bot";

/** Every record authored by the writer: [{key, parsed, state, ref}]. Forged records from other accounts are ignored. */
export function allRecords(items = [], writerLogin = WRITER_LOGIN) {
  const out = [];
  for (const it of items) {
    if (!isWriter(it?.user, writerLogin)) continue;
    for (const m of (it.body ?? "").matchAll(RECORD_RE)) {
      const parsed = parseOrchKey(m[1]);
      if (parsed) out.push({ key: m[1], parsed, state: m[2], ref: m[3] ? Number(m[3]) : undefined });
    }
  }
  return out;
}
export function recordsFor(items, key, writerLogin = WRITER_LOGIN) {
  return allRecords(items, writerLogin).filter((r) => r.key === key).map(({ state, ref }) => ({ state, ref }));
}

const EVENT_STEPS = new Set(["complete", "blocked"]);
const RANK = { claimed: 1, issue: 2, done: 3 };
/**
 * Durable state of one key from persisted records. States: none | claimed | issue | done | ambiguous.
 * Records are monotonic (claimed -> issue(ref) -> done(ref)). Conflicting refs, or an `issue`/`done`
 * without a ref where one is required, are ambiguous and fail closed.
 */
export function keyState(items, key, writerLogin) {
  const recs = recordsFor(items, key, writerLogin);
  if (recs.length === 0) return { state: "none" };
  const refs = new Set(recs.filter((r) => r.ref !== undefined).map((r) => r.ref));
  if (refs.size > 1) return { state: "ambiguous", why: "conflicting_refs", refs: [...refs] };
  const top = recs.reduce((a, r) => (RANK[r.state] > RANK[a.state] ? r : a));
  // F6 (#141): dispatching steps create an issue, so both `issue` and `done` need a ref. Event steps
  // (complete/blocked) legitimately record `done` with no ref.
  const refRequired = !EVENT_STEPS.has(parseOrchKey(key)?.step);
  if (refRequired && (top.state === "issue" || top.state === "done") && refs.size === 0) return { state: "ambiguous", why: top.state === "done" ? "done_without_ref" : "issue_without_ref" };
  return { state: top.state, ...(refs.size ? { ref: [...refs][0] } : {}) };
}

const stable = (v) => JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
export const planDigest = (plan) => createHash("sha256").update(stable(plan)).digest("hex").slice(0, 16);

const blocked = (reason, detail) => ({ mode: "dry-run", live: false, writes: [], action: "blocked", reason, ...(detail ? { detail } : {}) });
const noop = (reason, detail) => ({ mode: "dry-run", live: false, writes: [], action: "noop", reason, ...(detail ? { detail } : {}) });

// ---------------------------------------------------------------------------------------------
/** Simulated persistence of one planned write, for replay tests: returns the records a live writer WOULD leave. */
export function applySimulated(items, plan, { ref, writerLogin = WRITER_LOGIN } = {}) {
  const user = { login: writerLogin, type: "Bot" };
  const next = [...items];
  const key = plan.key;
  const push = (state, r) => next.push({ user, body: recordMarker(key, state, r) });
  const has = (t) => plan.writes?.some((w) => w.type === t);
  if (has("done_planned")) push("done", plan.ref);
  else if (has("issue_record_planned")) push("issue", ref ?? plan.ref);
  else if (has("claim_planned")) push("claimed");
  return next;
}

/**
 * Target / head / base validation against LIVE state. Allowlisted integration branch only; main is rejected.
 * `pr.state` may be open (open_review phase) or closed+merged (merged phase); closed-unmerged is rejected.
 * Replacement PRs: must target the allowlisted branch directly (no stacks) and CONTAIN the superseded head
 * (`ancestry` = compare of superseded head -> replacement head, echoing both exact SHAs). Every superseded PR
 * in the chain must be closed-unmerged (open => superseded_open, merged => superseded_merged).
 */
export function validateTarget({ pr, config, integrationTarget, expectedHead, expectedBase, superseded, ancestry, chainLinks, tip }) {
  const cfg = config ?? parseConfig({ allowlist: [integrationTarget].filter(Boolean), expectedBase });
  if (!cfg.ok) return `config_${cfg.reason}`;
  if (typeof integrationTarget !== "string" || !cfg.allowlist.includes(integrationTarget)) return "integration_target_not_allowlisted";
  if (!pr || typeof pr !== "object") return "pr_unavailable";
  if (!Number.isInteger(pr.number) || pr.number < 1) return "pr_malformed";
  const merged = pr.merged === true;
  if (pr.state !== "open" && !(pr.state === "closed" && merged)) return pr.state === "closed" ? "pr_closed_unmerged" : "pr_malformed";
  if (pr.base?.ref !== integrationTarget) return "base_not_integration_target";
  if (!SHA_RE.test(expectedHead ?? "") || pr.head?.sha !== expectedHead) return "head_mismatch";
  if (!merged) {
    // F1 (#141): open PR base must be an ANCESTOR of the LIVE integration tip. `tip` = {sha, cmp:{baseSha,headSha,status}}
    // where cmp compares pr.base.sha -> tip.sha. Tip movement (base behind tip) is fine; unknown/diverged fails closed.
    if (!SHA_RE.test(pr.base?.sha ?? "")) return "base_mismatch";
    if (!tip || !SHA_RE.test(tip.sha ?? "")) return "base_tip_unverified";
    const c = tip.cmp;
    if (!c || c.baseSha !== pr.base.sha || c.headSha !== tip.sha) return "base_tip_unverified";
    if (c.status !== "ahead" && c.status !== "identical") return c.status === "unknown" ? "base_tip_unverified" : "base_not_ancestor_of_tip";
  }
  // Issue #156: EVERY adjacent replacement link (newer -> older) is validated, not just the first. `chainLinks` =
  // [{newer, older, ancestry}] ordered from `pr` down to the original. Legacy single `superseded`+`ancestry` is link 0.
  const links = Array.isArray(chainLinks) ? chainLinks : superseded ? [{ newer: pr, older: superseded, ancestry }] : [];
  for (const { newer, older, ancestry: a } of links) {
    if (!older || !newer || !SHA_RE.test(older.head?.sha ?? "") || !SHA_RE.test(newer.head?.sha ?? "")) return "superseded_malformed";
    if (older.merged === true) return "superseded_merged";
    if (older.state !== "open" && older.state !== "closed") return "superseded_malformed";
    // Every old PR must be closed-unmerged before a replacement can be accepted; an open source is not safely superseded.
    if (older.state !== "closed") return "superseded_open";
    if (older.base?.ref !== integrationTarget) return "superseded_wrong_base";
    if (newer.head?.ref === older.head?.ref || older.number === newer.number) return "replacement_stack";
    if (!a || a.baseSha !== older.head.sha || a.headSha !== newer.head.sha) return "replacement_ancestry_unbound";
    if (a.status !== "ahead" && a.status !== "identical") return "replacement_ancestry_unproven";
  }
  return null;
}

/** Security capability state of the exact-head reviews: absent (not run / no entitlement) | blocked | invalid | pending. Never PASS. */
function securityStatusOf(exact) {
  const st = new Set(exact.map((r) => r.security_status ?? "not_run"));
  if (st.has("blocked")) return "blocked";
  if (st.has("invalid")) return "invalid";
  if (st.size === 0 || (st.size === 1 && st.has("not_run"))) return "absent";
  return "pending";
}

/**
 * Issue #161: separate UNMET gates (capability / security / CI / PM) from the pending USER decision. The decision is
 * pending only when every gate is met on the same exact SHA. PM evidence is a self-reported marker, never authority.
 */
export function approvalGates({ ev, headCi, sha }) {
  const unmet = [];
  if (ev.conflict || ev.pmConflict) unmet.push({ gate: "evidence", reason: "conflicting_evidence" });
  if (ev.codeVerdict === "missing") unmet.push({ gate: "code_review", reason: "no_independent_code_review_on_exact_sha" });
  else if (ev.codeVerdict === "findings") unmet.push({ gate: "code_review", reason: "unresolved_findings" });
  if (ev.security === "findings") unmet.push({ gate: "security", reason: "unresolved_findings" });
  else if (ev.security !== "pass" && ev.security !== "conflict") unmet.push({ gate: "security_capability", reason: `security_review_${ev.securityCapability}` });
  const ci = headCi?.sha === sha ? headCi.status : "missing";
  if (ci !== "success") unmet.push({ gate: "ci", reason: `ci_${ci}_on_exact_sha` });
  if (!ev.pmAcceptance) unmet.push({ gate: "pm_evidence", reason: ev.staleAccept ? "pm_acceptance_stale_sha_only" : "pm_acceptance_missing_on_exact_sha" });
  return { unmet, pendingDecision: unmet.length === 0 ? "user_approval" : null };
}

/**
 * Review evidence on the exact head. `reviews` are NORMALIZED records (lifecycle-evidence.mjs builds them from
 * the real `codex-review-state:v1` bot payload): {user, commit_sha, status, has_unresolved_findings}.
 * Independent = trusted Codex bot, not the PR author, exact SHA, completed, no unresolved findings, and no
 * contradicting verdict for the same SHA (conflict => fail closed).
 * PM acceptance uses the existing marker `gpt-pm-accept:v1 issue<N>:pr<P>:<sha>:target=<branch>`
 * (pre-parsed to `pmAccepts`). It is posted from the owner account that also authors work, so it is only a
 * SELF-REPORT: T5 never treats any marker as authenticated authority.
 */
export function reviewEvidence({ pr, sha, reviews = [], pmAccepts = [], pmRevises = [], req, acceptIssues, integrationTarget }) {
  // Issue #174: shared fail-closed selector (also used by the quality gate) — never re-implemented here.
  const { independent, unresolved, security, securityCapability, codeVerdict, stale, conflict } = selectReviewVerdict({ sha, reviews, prAuthor: pr.user?.login });
  const issues = acceptIssues ?? [req]; // root request, plus the revision issue the PR actually closes
  const accepts = pmAccepts.filter((a) => issues.includes(a.issue) && a.pr === pr.number && a.target === integrationTarget && a.sha === sha);
  const staleAccept = pmAccepts.some((a) => a.sha !== sha);
  const pmConflict = accepts.length > 0 && pmRevises.some((m) => m.sha === sha && m.pr === pr.number);
  const pm = accepts.length > 0 ? { sha, count: accepts.length } : null;
  return { independent, unresolved, security, securityCapability, codeVerdict, stale, conflict, pmAcceptance: pm, staleAccept, pmConflict, authority: pm ? "self_reported_marker" : "none" };
}

/**
 * Structured completion/blocked event with durable dedupe.
 *  - `complete`: once per request across ALL rounds and ALL PRs of the replacement chain.
 *  - `blocked` : once per (request, round) across the PR replacement chain.
 * `existing` are persisted items (comments); only the single writer's `done` records count.
 */
export function eventPlan({ kind, req, pr, round, existing = [], payload = {} }) {
  const key = orchKey({ req, pr, step: kind, round });
  const dup = allRecords(existing).find((r) => r.state === "done" && r.parsed.req === req && r.parsed.step === kind && (kind === "complete" || r.parsed.round === round));
  if (dup) return noop("event_already_recorded", { key, recorded: dup.key });
  return { mode: "dry-run", live: false, action: "emit_event", key, kind, writes: [{ type: "event_comment_planned", key }], payload };
}

/**
 * Ambiguous POST recovery. After a POST with unknown outcome, look the key up; never blind-retry.
 * `lookup` = { complete:boolean, matches:[{ref}] } from a bounded scan. Anything but a complete scan
 * with 0 or 1 match fails closed.
 */
export function recoverAmbiguousPost({ key, lookup }) {
  if (!lookup || lookup.complete !== true || !Array.isArray(lookup.matches)) return blocked("ambiguous_post_lookup_incomplete", { key });
  if (lookup.matches.length > 1) return blocked("ambiguous_post_duplicate_matches", { key, count: lookup.matches.length });
  if (lookup.matches.length === 1) return { mode: "dry-run", live: false, writes: [{ type: "issue_record_planned", key }], action: "adopt_existing", key, ref: lookup.matches[0].ref };
  return blocked("ambiguous_post_not_found_manual_retry", { key });
}

/**
 * Durable-claim gate for the step's key. none -> plan a claim (and the step); claimed -> in-flight, recover
 * via marker lookup (adopt / ambiguous), NEVER a second planned dispatch; issue -> adopt the recorded issue
 * and finalize; done -> noop; conflicting records -> blocked.
 */
function claimGate({ key, records, lookup, writerLogin }) {
  const ks = keyState(records, key, writerLogin);
  switch (ks.state) {
    case "ambiguous": return blocked("record_conflict", { key, ...ks });
    case "done": return noop("duplicate_key_done", { key });
    case "issue": return { mode: "dry-run", live: false, action: "adopt_existing", key, ref: ks.ref, writes: [{ type: "done_planned", key }] };
    case "claimed":
      if (lookup === undefined) return { mode: "dry-run", live: false, action: "in_flight", key, writes: [], why: "claimed_awaiting_marker_lookup" };
      return recoverAmbiguousPost({ key, lookup });
    default: return null;
  }
}

/**
 * Plan the single next mechanical step for a request. Deterministic in its inputs: replaying the same event
 * any number of times yields the same plan. No write is ever executed.
 * @param {object} i
 *  req, round, config {allowlist, expectedBase} | (integrationTarget + expectedBase), integrationTarget, pr (live),
 *  expectedHead, superseded, ancestry, reviews (normalized), pmAccepts, pmRevises, records (writer comments),
 *  lookup (claim recovery scan), ci {sha,status}, deployment {sha,env,status},
 *  merge {sha, headContained:boolean|"squash", tipContainsMerge:boolean}
 */
export function planLifecycle(i) {
  const plan = planCore(i);
  // F3 (#141): blocked outcomes go through the durable event dedupe (once per request+round across the whole PR
  // replacement chain). Planning only: the event is a planned write, nothing is posted.
  if (plan.action === "blocked" && Number.isInteger(i.req) && i.req > 0 && Number.isInteger(i.round) && i.round >= 1 && Number.isInteger(i.pr?.number) && i.pr.number > 0) {
    return { ...plan, event: eventPlan({ kind: "blocked", req: i.req, pr: i.pr.number, round: i.round, existing: i.records ?? [], payload: { reason: plan.reason } }) };
  }
  return plan;
}

function planCore(i) {
  const { req, round, pr } = i;
  if (!Number.isInteger(req) || req < 1) return blocked("invalid_req");
  if (!Number.isInteger(round) || round < 1) return blocked("invalid_round");
  const maxRounds = i.maxRounds ?? MAX_ROUNDS;
  if (!Number.isInteger(maxRounds) || maxRounds < MAX_ROUNDS || maxRounds > (MAX_ROUNDS_ROOT_EXCEPTIONS[req] ?? MAX_ROUNDS_CEILING)) return blocked("invalid_round_limit", { max: maxRounds });
  if (round > maxRounds) return blocked("round_cap_exceeded", { round, max: maxRounds });
  if (!pr) return noop("pr_unavailable");
  const bad = validateTarget(i);
  if (bad === "pr_closed_unmerged") return noop("pr_closed_unmerged");
  if (bad) return blocked(bad);
  if (pr.merged === true) return planMerged(i);
  return planOpenReview(i);
}

function planOpenReview(i) {
  const { req, round, pr, integrationTarget } = i;
  const sha = pr.head.sha;
  const ev = reviewEvidence({ pr, sha, reviews: i.reviews, pmAccepts: i.pmAccepts, pmRevises: i.pmRevises, req, acceptIssues: i.acceptIssues, integrationTarget });
  if (ev.conflict) return blocked("conflicting_review_evidence", { sha });
  if (ev.pmConflict) return blocked("conflicting_pm_evidence", { sha });

  let step, why;
  if (ev.unresolved) { step = "revise"; why = "unresolved_findings_on_exact_head"; }
  else if (!ev.independent) { step = "review"; why = ev.stale ? "stale_review_only" : "no_independent_review_on_exact_head"; }
  else if (!ev.pmAcceptance) { step = "accept"; why = ev.staleAccept ? "stale_pm_acceptance_only" : "awaiting_pm_acceptance_on_exact_sha"; }
  const gates = approvalGates({ ev, headCi: i.headCi, sha });
  // Issue #161: awaiting_user_approval needs same-SHA CI + code + security + PM self-report. It does NOT need merge or
  // deployment, and never approves/merges anything automatically.
  if (ev.independent && ev.pmAcceptance) { step = "accept"; why = gates.pendingDecision ? "awaiting_user_approval" : "pre_merge_gates_unmet"; }

  if (step === "revise" && round >= (i.maxRounds ?? MAX_ROUNDS)) return blocked("round_cap_reached_before_revision", { round, max: i.maxRounds ?? MAX_ROUNDS });
  const key = orchKey({ req, pr: pr.number, step, round });
  const gate = claimGate({ key, records: i.records ?? [], lookup: i.lookup, writerLogin: i.writerLogin });
  if (gate) return gate;
  // Open-phase never completes: completion needs merged integration evidence (separate phase).
  return {
    mode: "dry-run", live: false, action: "plan", phase: "open_review", step, key, sha, why, authority: ev.authority,
    lifecycleState: gates.pendingDecision ? "awaiting_user_approval" : "gates_unmet", unmet: gates.unmet, pendingDecision: gates.pendingDecision,
    completion: "not_applicable_until_merged", writes: [{ type: "claim_planned", key }, { type: `${step}_planned`, key }],
  };
}

function planMerged(i) {
  const { req, round, pr } = i;
  const head = pr.head.sha;
  const m = i.merge ?? {};
  const base = { mode: "dry-run", live: false, action: "plan", phase: "merged", head, writes: [], authority: "none" };
  if (!SHA_RE.test(pr.merge_commit_sha ?? "")) return blocked("merge_sha_missing", { head });
  const mergeSha = pr.merge_commit_sha;
  const evidence = { mergeSha, head };
  if (m.sha !== mergeSha) return { ...base, step: "await_merge_evidence", why: "merge_sha_not_verified", completion: "withheld", ...evidence };
  if (m.tipContainsMerge !== true) return { ...base, step: "await_merge_evidence", why: "merge_sha_not_on_integration_target", completion: "withheld", ...evidence };
  if (m.headContained !== true) return { ...base, step: "await_merge_evidence", why: m.headContained === "squash" ? "head_ancestry_unproven_squash_or_rebase" : "head_not_ancestor_of_merge_sha", completion: "withheld", ...evidence };
  // CI and dev deployment are bound to the MERGE SHA (never the PR head). F5 (#141): deployment evidence is the
  // Vercel commit status for that exact SHA (no GitHub "dev" environment is assumed). Anything else is withheld.
  const ci = i.ci?.sha === mergeSha && i.ci?.status === "success";
  const dep = i.deployment?.sha === mergeSha && i.deployment?.source === DEPLOY_SOURCE && i.deployment?.status === "success";
  if (!ci) return { ...base, step: "await_ci_deploy", why: "integration_ci_not_green_on_merge_sha", completion: "withheld", ...evidence };
  if (!dep) return { ...base, step: "await_ci_deploy", why: "dev_deployment_not_proven_on_merge_sha", completion: "withheld", ...evidence };

  const ev = reviewEvidence({ pr, sha: head, reviews: i.reviews, pmAccepts: i.pmAccepts, pmRevises: i.pmRevises, req, acceptIssues: i.acceptIssues, integrationTarget: i.integrationTarget });
  if (ev.conflict) return blocked("conflicting_review_evidence", { sha: head });
  if (ev.pmConflict) return blocked("conflicting_pm_evidence", { sha: head });
  if (!ev.independent) return { ...base, step: "await_review", why: "no_independent_review_on_exact_head", completion: "withheld", ...evidence };
  if (!ev.pmAcceptance) return { ...base, step: "await_acceptance", why: "awaiting_pm_acceptance_on_exact_sha", completion: "withheld", ...evidence };

  // All evidence present. Eligibility is reported SEPARATELY from completion: T6 authority is withheld, so a
  // self-reported marker can never produce `completion: "eligible"`; no write is planned.
  const key = orchKey({ req, pr: pr.number, step: "complete", round });
  const gate = claimGate({ key, records: i.records ?? [], lookup: i.lookup, writerLogin: i.writerLogin });
  if (gate) return gate;
  // F3 (#141): `complete` is recorded once per request across all rounds and PRs of the replacement chain.
  const evt = eventPlan({ kind: "complete", req, pr: pr.number, round, existing: i.records ?? [], payload: { mergeSha } });
  if (evt.action === "noop") return evt;
  return { ...base, event: evt, step: "complete", key, why: "pm_acceptance_not_authenticated_t6", authority: ev.authority, evidenceEligible: true, completion: "withheld", ...evidence };
}

/** Replay helper: evaluating the same input N times must collapse to one logical plan. */
export function replay(input, times = 3) {
  const digests = new Set();
  let first;
  for (let n = 0; n < times; n++) { const p = planLifecycle(structuredClone(input)); first ??= p; digests.add(planDigest(p)); }
  return { plan: first, distinctPlans: digests.size, digest: [...digests][0] };
}
