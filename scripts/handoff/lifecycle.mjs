// Issue #136 (T5) — single-writer coordinator lifecycle, DRY-RUN ONLY.
// Pure functions: no network, no GitHub client import, no side effects. The result is a *plan*
// (`mode: "dry-run"`, `live: false`); nothing here dispatches, merges, labels or writes. T6 owns the
// real OFF gate and authenticated approval.
import { createHash } from "node:crypto";
import { isTrustedCodex, isTrustedPm, PM_WRITER } from "./core.mjs";

export const KEY_VERSION = "v1";
export const STEPS = Object.freeze(["dispatch", "review", "revise", "accept", "complete", "blocked"]);
export const MAX_ROUNDS = 3;
const FORBIDDEN_TARGETS = new Set(["main", "master", "production", "prod", "release"]);
const SHA_RE = /^[a-f0-9]{40}$/;
const KEY_RE = /^orch:v1:req(\d+):pr(\d+):(dispatch|review|revise|accept|complete|blocked):r([1-9]\d*)$/;

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

/** Claim/issue/done markers are only honoured from the writer identity. `state` ∈ claimed|issue|done. */
const RECORD_RE = /<!--\s*orch-record:(orch:v1:req\d+:pr\d+:[a-z]+:r[1-9]\d*)\s+state=(claimed|issue|done)(?:\s+ref=(\d+))?\s*-->/g;
export const recordMarker = (key, state, ref) => `<!-- orch-record:${key} state=${state}${ref ? ` ref=${ref}` : ""} -->`;
export function recordsFor(items, key, writerLogin = "github-actions[bot]") {
  const out = [];
  for (const it of items) {
    if (it?.user?.login !== writerLogin) continue; // forged records from other accounts are ignored
    for (const m of (it.body ?? "").matchAll(RECORD_RE)) if (m[1] === key) out.push({ state: m[2], ref: m[3] ? Number(m[3]) : undefined });
  }
  return out;
}

const stable = (v) => JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
export const planDigest = (plan) => createHash("sha256").update(stable(plan)).digest("hex").slice(0, 16);

const blocked = (reason, detail) => ({ mode: "dry-run", live: false, writes: [], action: "blocked", reason, ...(detail ? { detail } : {}) });
const noop = (reason, detail) => ({ mode: "dry-run", live: false, writes: [], action: "noop", reason, ...(detail ? { detail } : {}) });

/**
 * Target / head / base validation against LIVE state. Integration branch only; main is rejected.
 * Replacement PRs must target the integration branch directly (no stacks) and descend from the
 * superseded PR's head (`ancestry` = compare status of superseded head -> replacement head).
 */
export function validateTarget({ pr, integrationTarget, expectedHead, expectedBase, superseded, ancestry }) {
  if (!integrationTarget || FORBIDDEN_TARGETS.has(integrationTarget)) return "integration_target_forbidden";
  if (!pr || pr.state !== "open") return "pr_not_open";
  if (pr.base?.ref !== integrationTarget) return "base_not_integration_target";
  if (FORBIDDEN_TARGETS.has(pr.base?.ref)) return "base_forbidden";
  if (!SHA_RE.test(expectedHead ?? "") || pr.head?.sha !== expectedHead) return "head_mismatch";
  if (expectedBase && pr.base?.sha !== expectedBase) return "base_mismatch";
  if (superseded) {
    if (superseded.state !== "closed") return "superseded_not_closed";
    if (superseded.base?.ref !== integrationTarget) return "superseded_wrong_base";
    if (pr.base?.ref !== integrationTarget || pr.head?.ref === superseded.head?.ref) return "replacement_stack";
    if (ancestry !== "ahead" && ancestry !== "identical") return "replacement_ancestry_unproven";
  }
  return null;
}

/**
 * Review evidence. `independent` reviews must come from a trusted reviewer identity that is neither the PR
 * author nor the developer, be bound to the exact SHA, and be completed with no unresolved findings.
 * Authority ladder: a PM acceptance marker posted by the same account that authored/dev'd the PR (the owner
 * account GPT also posts through) is only a SELF-REPORT. T5 never treats any marker as authenticated authority.
 */
export function reviewEvidence({ pr, sha, reviews = [], comments = [], round, req }) {
  const trusted = reviews.filter((r) => isTrustedCodex(r.user) && r.commit_sha === sha && r.status === "completed"
    && r.user.login !== pr.user?.login);
  const stale = reviews.some((r) => isTrustedCodex(r.user) && r.commit_sha !== sha);
  const independent = trusted.length > 0 && trusted.every((r) => r.has_unresolved_findings === false);
  const unresolved = trusted.some((r) => r.has_unresolved_findings === true);
  const acceptKey = orchKey({ req, pr: pr.number, step: "accept", round });
  const ACCEPT_RE = new RegExp(`<!--\\s*pm-accept:${acceptKey.replace(/:/g, "\\:")}\\s+sha=([a-f0-9]{40})\\s*-->`);
  let pm = null;
  for (const c of comments) {
    if (!isTrustedPm(c.user)) continue;
    const m = ACCEPT_RE.exec(c.body ?? "");
    if (m && m[1] === sha) pm = { commentId: c.id, sha: m[1] };
  }
  // Same-account PM marker: login==PM_WRITER.login also authors/commits the work -> self-report, not authority.
  const authority = pm ? "self_reported_marker" : "none";
  return { independent, unresolved, stale, pmAcceptance: pm, authority, pmIdentity: PM_WRITER.login };
}

/** Structured completion/blocked event with dedupe against already-recorded events. */
export function eventPlan({ kind, req, pr, round, existing = [], payload = {} }) {
  const key = orchKey({ req, pr, step: kind, round });
  if (recordsFor(existing, key).some((r) => r.state === "done")) return noop("event_already_recorded", { key });
  return { mode: "dry-run", live: false, action: "emit_event", key, kind, writes: [{ type: "event_comment_planned", key }], payload };
}

/**
 * Ambiguous POST recovery. After a POST with unknown outcome, look the key up; never blind-retry.
 * `lookup` = { complete:boolean, matches:[{ref}] } from a bounded scan. Anything but a complete scan
 * with 0 or 1 match fails closed.
 */
export function recoverAmbiguousPost({ key, lookup }) {
  if (!lookup || lookup.complete !== true) return blocked("ambiguous_post_lookup_incomplete", { key });
  if (lookup.matches.length > 1) return blocked("ambiguous_post_duplicate_matches", { key, count: lookup.matches.length });
  if (lookup.matches.length === 1) return { mode: "dry-run", live: false, writes: [], action: "adopt_existing", key, ref: lookup.matches[0].ref };
  // Zero matches on a complete scan: still requires the claim to exist and an explicit operator retry; no auto POST.
  return blocked("ambiguous_post_not_found_manual_retry", { key });
}

/**
 * Plan the single next mechanical step for a request. Deterministic in its inputs: replaying the same event
 * any number of times yields the same plan (same key, same digest). No write is ever executed.
 * @param {object} i
 *  req, round, integrationTarget, pr (live), expectedHead, expectedBase, superseded, ancestry,
 *  reviews, comments (PR comments incl. records), ci {sha,status}, deployment {sha,env,status}
 */
export function planLifecycle(i) {
  const { req, round, pr } = i;
  if (!Number.isInteger(round) || round < 1) return blocked("invalid_round");
  if (round > MAX_ROUNDS) return blocked("round_cap_exceeded", { round, max: MAX_ROUNDS });
  if (!pr) return noop("pr_unavailable");
  const bad = validateTarget(i);
  if (bad === "pr_not_open") return noop("pr_not_open");
  if (bad) return blocked(bad);
  const sha = pr.head.sha;
  const records = i.comments ?? [];
  const ev = reviewEvidence({ pr, sha, reviews: i.reviews, comments: records, round, req });

  let step, why;
  if (ev.unresolved) { step = "revise"; why = "unresolved_findings_on_exact_head"; }
  else if (!ev.independent) { step = "review"; why = ev.stale ? "stale_review_only" : "no_independent_review_on_exact_head"; }
  else if (!ev.pmAcceptance) { step = "accept"; why = "awaiting_pm_acceptance_on_exact_sha"; }
  else { step = "complete"; why = "evidence_present"; }

  if (step === "revise" && round >= MAX_ROUNDS) return blocked("round_cap_reached_before_revision", { round, max: MAX_ROUNDS });
  const key = orchKey({ req, pr: pr.number, step: step === "complete" ? "complete" : step, round });
  const done = recordsFor(records, key).some((r) => r.state === "done");
  if (done) return noop("duplicate_key_done", { key });

  const base = { mode: "dry-run", live: false, writes: [{ type: `${step}_planned`, key }], step, key, sha, why, authority: ev.authority };
  if (step !== "complete") return { action: "plan", ...base };

  // Completion truth: never claim done before integration CI AND the exact dev deployment are proven on this SHA.
  const ci = i.ci?.sha === sha && i.ci?.status === "success";
  const dep = i.deployment?.sha === sha && i.deployment?.env === "dev" && i.deployment?.status === "success";
  if (!ci || !dep) return { action: "plan", ...base, step: "await_ci_deploy", key: orchKey({ req, pr: pr.number, step: "accept", round }), writes: [], why: !ci ? "integration_ci_not_green_on_exact_sha" : "dev_deployment_not_proven_on_exact_sha", completion: "withheld" };
  // Even with every proof, a same-account marker is not authenticated authority (T6): record as pending authority.
  if (ev.authority !== "authenticated") return { action: "plan", ...base, writes: [], completion: "withheld", why: "pm_acceptance_not_authenticated_t6" };
  return { action: "plan", ...base, completion: "eligible" };
}

/** Replay helper: evaluating the same input N times must collapse to one logical plan. */
export function replay(input, times = 3) {
  const digests = new Set();
  let first;
  for (let n = 0; n < times; n++) { const p = planLifecycle(structuredClone(input)); first ??= p; digests.add(planDigest(p)); }
  return { plan: first, distinctPlans: digests.size, digest: [...digests][0] };
}
