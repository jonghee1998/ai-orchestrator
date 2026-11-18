// Issue #182 — verified CORRECTION BOUNDARY for the quality gate's pre-code evidence timing.
// `firstCodeCommitAt` must be the time of the first commit NEW to THIS correction, never of inherited (superseded, unmerged) commits.
// Boundary = superseded PR HEAD (source) -> current PR HEAD, proven by a full compare. The source SHA/PR is taken from TRUSTED lineage
// (trusted-PM revision-issue marker `gpt-pm-followup:pr<N>:<sha>` AND the trusted-PM supersedes marker AND the superseded PR's live head);
// an attacker-editable PR body alone is never accepted. Every gap returns {error} (callers BLOCK); nothing here ever defaults to a time.
import { pmReviseMarkers } from "../handoff/core.mjs";
import { supersedesMarker } from "../handoff/lifecycle-evidence.mjs";

const SHA = /^[a-f0-9]{40}$/;
export const COMMIT_API_CAP = 250; // /pulls/N/commits and compare both stop here: at/over it the set cannot be proven complete
export const CLOCK_SKEW_MS = 5 * 60 * 1000;
const tms = (c) => Date.parse(c?.commit?.committer?.date ?? "");

/**
 * @param {{gh:object, pr:object, linkedIssue:object, commits:object[], now?:number}} i
 *   commits: complete listPullCommits(pr) result (used only for the original PR of a chain).
 * @returns {{firstCodeCommitAt:string, boundary:'original'|'correction', source?:{pr:number,sha:string}, newCommits?:number} | {error:string, detail?:object}}
 */
export async function resolveCorrectionBoundary({ gh, pr, linkedIssue, commits, now = Date.now() }) {
  const m = supersedesMarker(pr);
  if (m === null) return { error: "supersedes_marker_missing" };
  if (m === "ambiguous") return { error: "supersedes_marker_ambiguous" };
  const maxAllowed = now + CLOCK_SKEW_MS;
  if (m === "none") {
    // ORIGINAL PR of a chain: every commit on it is its own work. Complete enumeration required.
    const times = (commits ?? []).map(tms);
    if (!Array.isArray(commits) || commits.length === 0 || commits.length >= COMMIT_API_CAP || times.some((t) => !Number.isFinite(t))) return { error: "commit_enumeration_incomplete" };
    if (times.some((t) => t > maxAllowed)) return { error: "commit_time_forged", detail: { reason: "future" } };
    return { firstCodeCommitAt: new Date(Math.min(...times)).toISOString(), boundary: "original" };
  }
  // CORRECTION: source from trusted lineage. Revision-issue markers (trusted PM author only) must all name THIS superseded PR and one SHA.
  const marks = pmReviseMarkers({ ...linkedIssue, kind: "issue" });
  if (!marks.length) return { error: "source_not_recorded_in_trusted_lineage" };
  if (marks.some((k) => k.pr !== m)) return { error: "source_pr_conflict", detail: { supersedes: m } };
  const shas = new Set(marks.map((k) => k.sha));
  if (shas.size !== 1) return { error: "source_sha_ambiguous" };
  const sha = [...shas][0];
  if (!SHA.test(sha ?? "") || !SHA.test(pr.head?.sha ?? "")) return { error: "head_unknown" };
  let sup, srcCommit, cmp;
  try { sup = await gh.getPull(m); } catch { return { error: "superseded_pr_unavailable" }; }
  if (!sup || sup.number !== m || sup.head?.sha !== sha) return { error: "source_sha_mismatch", detail: { pr: m } }; // force-push / amended source
  try { srcCommit = await gh.getCommit(sha); } catch { return { error: "source_commit_unavailable" }; }
  const srcTime = tms(srcCommit);
  if (!Number.isFinite(srcTime)) return { error: "source_commit_time_unknown" };
  try { cmp = await gh.compareCommits(sha, pr.head.sha); } catch { return { error: "compare_unavailable" }; }
  if (!cmp || !Array.isArray(cmp.commits)) return { error: "compare_unavailable" };
  if (cmp.status === "identical" || cmp.ahead_by === 0) return { error: "no_new_commit" };
  if (cmp.status !== "ahead" || cmp.behind_by !== 0) return { error: "boundary_not_descendant", detail: { status: String(cmp.status).slice(0, 20) } }; // rewrite / diverged / behind
  if (cmp.merge_base_sha !== sha) return { error: "boundary_merge_base_mismatch" };
  const n = cmp.commits.length;
  if (n === 0 || n >= COMMIT_API_CAP || cmp.ahead_by !== n || cmp.total_commits !== n || cmp.commits[n - 1]?.sha !== pr.head.sha) return { error: "new_commit_enumeration_incomplete" };
  const times = cmp.commits.map(tms);
  if (times.some((t) => !Number.isFinite(t))) return { error: "commit_time_unknown" };
  if (times.some((t) => t > maxAllowed || t < srcTime)) return { error: "commit_time_forged" }; // future-dated, or older than the boundary it descends from
  return { firstCodeCommitAt: new Date(Math.min(...times)).toISOString(), boundary: "correction", source: { pr: m, sha }, newCommits: n };
}
