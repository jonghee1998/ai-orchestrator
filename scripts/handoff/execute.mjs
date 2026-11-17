// Issue #73 — side-effecting half of the coordinator. Idempotent and crash-safe:
//   revise:        claim comment (state=claimed) → create issue (marker in body) → claim edited to state=done issue=N
//   release_ready: one comment (state=done) is both the claim and the record.
// A rerun after a crash at any step converges without a duplicate issue: a pending claim is resolved
// by looking for the coordinator-authored issue carrying the same marker before creating a new one.
// Concurrency: the workflow serializes per PR (concurrency group, no cancel), so check-then-write
// has a single writer per PR. Head SHA is re-read immediately before every write (stale guard).
import { decide, findClaim, claimBody, revisionIssue, markerFor, linkedIssueNumbers, DEFAULT_WRITER_LOGIN, codexReportObservation } from "./core.mjs";

export async function loadState(gh, prNumber) {
  const pr = await gh.getPull(prNumber);
  const comments = await gh.listIssueComments(prNumber);
  const refs = linkedIssueNumbers(pr);
  const linkedIssue = refs.length === 1 ? await gh.getIssue(refs[0]).catch(() => null) : null;
  const state = { pr, comments, linkedIssue, pmEvidence: [] };
  // Issue-side PM handoffs (linked issue, separate revision issues) are only needed to veto a revise.
  // Fetched lazily; any failure propagates (fail closed: no write without the full transition guard).
  if (decide(state).action === "revise") state.pmEvidence = await gh.listIssueSideEvidence(pr.created_at);
  return state;
}

/** @param {{apply:boolean, writerLogin?:string, repo:string, log?:(o:object)=>void}} opts */
export async function run(gh, prNumber, opts) {
  const log = opts.log ?? (() => {});
  const writer = opts.writerLogin ?? DEFAULT_WRITER_LOGIN;
  const state = await loadState(gh, prNumber);
  const plan = decide(state);
  log({ step: "codex_evidence_observation", pr: prNumber, ...codexReportObservation(state.pr, state.comments) });
  log({ step: "plan", pr: prNumber, plan: summarize(plan) });
  if (plan.action === "noop") return { result: "noop", reason: plan.reason };

  const claim = findClaim(state.comments, plan.key, writer);
  if (claim?.state === "done") return { result: "duplicate", key: plan.key, claim: claim.commentId };
  if (!opts.apply) return { result: "dry_run", key: plan.key, wouldDo: plan.action, resumeClaim: claim?.commentId ?? null };

  const assertHead = async () => {
    const live = await gh.getPull(prNumber);
    if (live.state !== "open" || live.head.sha !== plan.sha) throw new StaleError(plan.sha, live.head.sha);
  };

  try {
    if (plan.action === "release_ready") {
      await assertHead();
      const c = await gh.createIssueComment(prNumber, claimBody(plan, "done"));
      return { result: "recorded_release_ready", key: plan.key, comment: c.id };
    }
    let claimId = claim?.commentId;
    let issueNumber;
    if (claimId) {
      // Resume a crashed run: was the issue already created?
      const existing = await gh.findIssueByMarker(markerFor(plan.key), writer, claim.createdAt);
      issueNumber = existing?.number;
    } else {
      await assertHead();
      claimId = (await gh.createIssueComment(prNumber, claimBody(plan, "claimed"))).id;
    }
    if (!issueNumber) {
      await assertHead();
      issueNumber = (await gh.createIssue(revisionIssue(plan, state.pr, opts.repo))).number;
    }
    await gh.updateIssueComment(claimId, claimBody(plan, "done", issueNumber));
    return { result: "created_revision_issue", key: plan.key, issue: issueNumber, claim: claimId };
  } catch (e) {
    if (e instanceof StaleError) return { result: "noop", reason: "head_moved_before_write", detail: e.detail };
    throw e;
  }
}

export class StaleError extends Error {
  constructor(planned, live) { super(`head moved ${planned} -> ${live}`); this.detail = { planned, live }; }
}

function summarize(p) {
  return p.action === "noop" ? p : { action: p.action, key: p.key, agent: p.agent, linkedIssue: p.linkedIssue, codexComment: p.codex?.commentId };
}
