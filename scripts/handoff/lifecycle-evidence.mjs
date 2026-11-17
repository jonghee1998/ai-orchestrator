// Issue #138 — normalize REAL GitHub payloads into the evidence the lifecycle planner consumes.
// Read-only and pure. Nothing here is "authenticated authority": identities are checked by login+id+type,
// markers are structured, anything malformed/unknown is dropped (fail closed).
import { DEPLOY_SOURCE } from "./lifecycle.mjs";
import { isTrustedCodex, isTrustedPm, parseCodexState, pmReviseMarkers, linkedIssueNumbers, isAmbiguousCodexReceipt, mentionedShas } from "./core.mjs";

const SHA = /^[a-f0-9]{40}$/;
/** Existing PM acceptance marker (src/lib/github/evidence.ts): gpt-pm-accept:v1 issue<N>:pr<P>:<sha>:target=<branch> */
const PM_ACCEPT_RE = /<!--\s*gpt-pm-accept:v1\s+issue(\d+):pr(\d+):([a-f0-9]{40}):target=([A-Za-z0-9_./-]+)\s*-->/g;

/** Codex review verdicts come ONLY from the trusted bot's `codex-review-state:v1` summary comment (real payload). */
export function normalizeCodexReviews(comments = []) {
  const out = [];
  for (const c of comments) {
    if (!isTrustedCodex(c?.user)) continue;
    const s = parseCodexState(c.body);
    if (!s) {
      // Issue #166: an ambiguous trusted receipt (multiple/malformed markers) is preserved, bound to every SHA it names.
      if (isAmbiguousCodexReceipt(c)) out.push({ trusted: true, ambiguous: true, user: { login: c.user.login, id: c.user.id, type: c.user.type }, commit_sha: null, mentioned_shas: mentionedShas(c.body), commentId: c.id });
      continue;
    }
    out.push({ trusted: true, user: { login: c.user.login, id: c.user.id, type: c.user.type }, commit_sha: s.commitSha, status: s.status,
      has_unresolved_findings: s.hasUnresolvedFindings,
      security_status: s.security?.status ?? "not_run", security_unresolved: s.security?.hasUnresolvedFindings, commentId: c.id });
  }
  return out;
}

export function pmAcceptMarkers(items = []) {
  const out = [];
  for (const c of items) {
    if (!isTrustedPm(c?.user)) continue;
    for (const m of (c.body ?? "").matchAll(PM_ACCEPT_RE)) out.push({ issue: Number(m[1]), pr: Number(m[2]), sha: m[3], target: m[4], commentId: c.id });
  }
  return out;
}
export const pmRevises = (items = []) => items.flatMap((c) => pmReviseMarkers(c));

/**
 * Check runs for one SHA -> {sha,status}. F4 (#141): the API returns one page (<=100); `total_count` must be present
 * and equal the runs returned, otherwise the evidence is `incomplete` (a hidden failing run could exist).
 * success needs >=1 REAL success: all-skipped / all-neutral is not green.
 */
export function ciFromCheckRuns(sha, payload) {
  const runs = Array.isArray(payload?.check_runs) ? payload.check_runs : null;
  if (!runs || runs.length === 0) return { sha, status: "missing" };
  if (!Number.isInteger(payload.total_count) || payload.total_count !== runs.length) return { sha, status: "incomplete" };
  if (runs.some((r) => r.head_sha !== sha)) return { sha, status: "malformed" };
  if (runs.some((r) => r.status !== "completed")) return { sha, status: "pending" };
  if (!runs.every((r) => ["success", "skipped", "neutral"].includes(r.conclusion))) return { sha, status: "failure" };
  return runs.some((r) => r.conclusion === "success") ? { sha, status: "success" } : { sha, status: "all_skipped" };
}

/**
 * Dev/preview deployment evidence from the Vercel COMMIT STATUS on the exact SHA (GET /commits/{sha}/status).
 * This repo's Vercel integration reports a commit status (context "Vercel"), not a GitHub deployment
 * environment, so no environment name is assumed. `statuses` is capped at 100 by the API: if total_count exceeds
 * what was returned, or the payload echoes another SHA, the evidence is incomplete/malformed (withheld).
 * Only the newest status per context counts; the Vercel context must be exactly "Vercel" and `success`.
 */
export const VERCEL_CONTEXT = "Vercel";
export function deploymentFromCommitStatus(sha, payload) {
  const base = { sha, source: DEPLOY_SOURCE };
  const list = Array.isArray(payload?.statuses) ? payload.statuses : null;
  if (!list) return { ...base, status: "missing" };
  if (payload.sha !== sha) return { ...base, status: "malformed" };
  if (!Number.isInteger(payload.total_count) || payload.total_count !== list.length) return { ...base, status: "incomplete" };
  const vercel = list.filter((x) => x?.context === VERCEL_CONTEXT);
  if (vercel.length === 0) return { ...base, status: "missing" };
  const newest = [...vercel].sort((x, y) => (String(x.updated_at ?? x.created_at) < String(y.updated_at ?? y.created_at) ? 1 : -1))[0];
  return { ...base, status: typeof newest.state === "string" ? newest.state : "unknown" };
}

/** Compare payload -> ancestry echoing both exact SHAs (so the planner can verify what was compared). */
export function ancestryFrom(baseSha, headSha, cmp) {
  const status = ["ahead", "identical", "behind", "diverged"].includes(cmp?.status) ? cmp.status : "unknown";
  return { baseSha, headSha, status };
}

/** Branch tip + compare(pr.base.sha -> tip) -> the live-tip evidence validateTarget needs (F1). Fail closed on any gap. */
export function tipFrom(baseSha, branch, cmp) {
  const sha = branch?.commit?.sha;
  if (!SHA.test(sha ?? "")) return null;
  return { sha, cmp: ancestryFrom(baseSha, sha, cmp) };
}

/**
 * Canonical ROOT request (Issue #144: explicit, never inferred). Every request issue in a chain, the root itself
 * (self-reference) and every revision, MUST carry `<!-- orch-root-request:v1 #<root> -->` in its body, honoured only
 * from the trusted PM author. Returns the marker target, `null` (missing / untrusted => callers fail closed; there is
 * NO implicit "unmarked issue is its own root" fallback) or "ambiguous" (conflicting markers).
 */
const ROOT_RE = /<!--\s*orch-root-request:v1\s+#(\d+)\s*-->/g;
export function rootMarker(issue) {
  if (!isTrustedPm(issue?.user)) return null;
  const set = new Set([...(issue.body ?? "").matchAll(ROOT_RE)].map((m) => Number(m[1])));
  return set.size === 0 ? null : set.size === 1 ? [...set][0] : "ambiguous";
}

/**
 * Replacement marker in the PR body, trusted PM author only: `<!-- orch-supersedes:v1 pr<N> -->` or
 * `<!-- orch-supersedes:v1 none -->` (original PR of the chain). Returns N, "none", `null` (missing / untrusted =>
 * callers fail closed, no implicit "none") or "ambiguous" (any conflicting or repeated-different markers).
 */
const SUPERSEDES_RE = /<!--\s*orch-supersedes:v1\s+(?:pr(\d+)|(none))\s*-->/g;
export function supersedesMarker(pr) {
  if (!isTrustedPm(pr?.user)) return null;
  const set = new Set([...(pr.body ?? "").matchAll(SUPERSEDES_RE)].map((m) => (m[2] ? "none" : Number(m[1]))));
  return set.size === 0 ? null : set.size === 1 ? [...set][0] : "ambiguous";
}

/** Request id = the single issue the PR links via keyword refs; anything else is unresolvable. */
export function reqFromPr(pr) {
  const refs = linkedIssueNumbers(pr);
  return refs.length === 1 ? refs[0] : null;
}
