// Issue #138 — normalize REAL GitHub payloads into the evidence the lifecycle planner consumes.
// Read-only and pure. Nothing here is "authenticated authority": identities are checked by login+id+type,
// markers are structured, anything malformed/unknown is dropped (fail closed).
import { isTrustedCodex, isTrustedPm, parseCodexState, pmReviseMarkers, linkedIssueNumbers } from "./core.mjs";

const SHA = /^[a-f0-9]{40}$/;
/** Existing PM acceptance marker (src/lib/github/evidence.ts): gpt-pm-accept:v1 issue<N>:pr<P>:<sha>:target=<branch> */
const PM_ACCEPT_RE = /<!--\s*gpt-pm-accept:v1\s+issue(\d+):pr(\d+):([a-f0-9]{40}):target=([A-Za-z0-9_./-]+)\s*-->/g;

/** Codex review verdicts come ONLY from the trusted bot's `codex-review-state:v1` summary comment (real payload). */
export function normalizeCodexReviews(comments = []) {
  const out = [];
  for (const c of comments) {
    if (!isTrustedCodex(c?.user)) continue;
    const s = parseCodexState(c.body);
    if (!s) continue;
    out.push({ trusted: true, user: { login: c.user.login, id: c.user.id, type: c.user.type }, commit_sha: s.commitSha, status: s.status,
      has_unresolved_findings: s.hasUnresolvedFindings, commentId: c.id });
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

/** Check runs for one SHA -> {sha,status}. success only if >=1 run, all completed, all success/skipped/neutral. */
export function ciFromCheckRuns(sha, payload) {
  const runs = Array.isArray(payload?.check_runs) ? payload.check_runs : null;
  if (!runs || runs.length === 0) return { sha, status: "missing" };
  if (runs.some((r) => r.head_sha !== sha)) return { sha, status: "malformed" };
  if (runs.some((r) => r.status !== "completed")) return { sha, status: "pending" };
  if (runs.every((r) => ["success", "skipped", "neutral"].includes(r.conclusion))) return { sha, status: "success" };
  return { sha, status: "failure" };
}

/** Latest dev deployment for the SHA with its newest status. `statusesById` maps deployment id -> statuses[]. */
export function deploymentFromApi(sha, deployments, statusesById) {
  const dev = (Array.isArray(deployments) ? deployments : []).filter((d) => d.sha === sha && d.environment === "dev");
  if (dev.length === 0) return { sha, env: "dev", status: "missing" };
  const newest = [...dev].sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
  const st = (statusesById?.[newest.id] ?? [])[0];
  return { sha, env: "dev", status: st?.state ?? "unknown" };
}

/** Compare payload -> ancestry echoing both exact SHAs (so the planner can verify what was compared). */
export function ancestryFrom(baseSha, headSha, cmp) {
  const status = ["ahead", "identical", "behind", "diverged"].includes(cmp?.status) ? cmp.status : "unknown";
  return { baseSha, headSha, status };
}

/** Request id = the single issue the PR links via keyword refs; anything else is unresolvable. */
export function reqFromPr(pr) {
  const refs = linkedIssueNumbers(pr);
  return refs.length === 1 ? refs[0] : null;
}
