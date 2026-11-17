// Issue #73 — deterministic, repository-owned review handoff coordinator (pure decision logic).
//
// The triggering webhook event is only a wake-up signal. Every decision is re-derived from LIVE
// GitHub state: the PR head SHA and the machine-readable `codex-review-state:v1` marker posted by
// the Codex connector App. Comment prose is never interpreted as instructions; only that marker's
// fixed JSON fields (commit_sha / status / has_unresolved_findings) are read, and only from the
// trusted App identity (login AND numeric id AND type Bot).

export const MARKER_VERSION = "v1";
/** Codex connector App identity observed on PR #72 (comment 6890098358). Login alone is not trusted. */
export const CODEX_BOT = Object.freeze({ login: "chatgpt-codex-connector[bot]", id: 199175422 });
/** Identity of the coordinator's own writes (GITHUB_TOKEN). Claims from any other author are ignored. */
export const DEFAULT_WRITER_LOGIN = "github-actions[bot]";
const AGENTS = new Set(["claude", "opus", "codex"]);

export function isTrustedCodex(user) {
  return !!user && user.login === CODEX_BOT.login && Number(user.id) === CODEX_BOT.id && user.type === "Bot";
}

const STATE_RE = /<!--\s*codex-review-state:v1\s+(\{[\s\S]*?\})\s*-->/;
/** Parse the connector's structured state. Returns null on any shape deviation (fail closed). */
export function parseCodexState(body) {
  const m = STATE_RE.exec(body ?? "");
  if (!m) return null;
  let j;
  try { j = JSON.parse(m[1]); } catch { return null; }
  const cr = j && typeof j === "object" ? j.code_review : null;
  if (!cr || typeof cr !== "object") return null;
  const sha = cr.commit_sha;
  if (typeof sha !== "string" || !/^[a-f0-9]{40}$/.test(sha)) return null;
  if (typeof cr.status !== "string") return null;
  const unresolved = cr.has_unresolved_findings;
  if (cr.status === "completed" && typeof unresolved !== "boolean") return null;
  return { commitSha: sha, status: cr.status, hasUnresolvedFindings: unresolved, security: parseSecurity(j.security_review, sha) };
}

/**
 * Issue #156: security review is tracked SEPARATELY from code review. Absent/null => `not_run` (never PASS).
 * Present but malformed, or bound to a different SHA => `invalid`. `completed` needs a boolean findings flag.
 * @returns {{status:string, hasUnresolvedFindings?:boolean}}
 */
export function parseSecurity(sr, sha) {
  if (sr === undefined || sr === null) return { status: "not_run" };
  if (typeof sr !== "object") return { status: "invalid" };
  // Real connector shape when no security review ran: `{ "commit_sha": null }` (no status).
  if (sr.status === undefined && sr.commit_sha === null) return { status: "not_run" };
  if (typeof sr.status !== "string") return { status: "invalid" };
  if (sr.commit_sha !== undefined && sr.commit_sha !== sha) return { status: "invalid" };
  if (sr.status === "completed") {
    return typeof sr.has_unresolved_findings === "boolean" ? { status: "completed", hasUnresolvedFindings: sr.has_unresolved_findings } : { status: "invalid" };
  }
  return { status: sr.status };
}

/** Latest trusted Codex state among PR conversation comments (by updated_at; the summary comment is edited in place). */
export function latestCodexState(comments) {
  let best = null;
  for (const c of comments) {
    if (!isTrustedCodex(c.user)) continue;
    const s = parseCodexState(c.body);
    if (!s) continue;
    const at = c.updated_at ?? c.created_at;
    if (!best || at > best.at) best = { ...s, at, commentId: c.id, url: c.html_url };
  }
  return best;
}

const KEYWORD_REF = /\b(?:refs?|close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s*#(\d+)/gi;
/** Issues the PR explicitly addresses via keyword refs in its body (`Refs #71`, `Closes #9`). */
export function linkedIssueNumbers(pr) {
  const body = (pr.body ?? "").replace(/<!--[\s\S]*?-->/g, " ");
  return [...new Set([...body.matchAll(KEYWORD_REF)].map((m) => Number(m[1])))];
}

export function agentOf(issue) {
  const names = (issue?.labels ?? []).map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean);
  const agents = names.filter((n) => n.startsWith("agent:")).map((n) => n.slice(6));
  return agents.length === 1 && AGENTS.has(agents[0]) ? agents[0] : null;
}

export const handoffKey = (pr, sha, outcome) => `pr${pr}:${sha}:codex:${outcome}`;
export const markerFor = (key) => `<!-- handoff-coordinator:${MARKER_VERSION} ${key} -->`;
const MARKER_RE = /<!--\s*handoff-coordinator:v1\s+(pr\d+:[a-f0-9]{40}:codex:(?:revise|release-ready))(?:\s+state=(claimed|done))?(?:\s+issue=(\d+))?\s*-->/;
export function parseMarker(body) {
  const m = MARKER_RE.exec(body ?? "");
  return m ? { key: m[1], state: m[2] ?? "done", issue: m[3] ? Number(m[3]) : undefined } : null;
}

/** The coordinator's own claim for `key` (only comments authored by the writer identity count). */
export function findClaim(comments, key, writerLogin = DEFAULT_WRITER_LOGIN) {
  for (const c of comments) {
    if (c.user?.login !== writerLogin) continue;
    const m = parseMarker(c.body);
    if (m && m.key === key) return { ...m, commentId: c.id, createdAt: c.created_at };
  }
  return null;
}

/**
 * Identity of the existing GPT PM writer (it posts through the owner account). Login alone is not
 * trusted: login AND numeric id AND type User must all match, exactly like CODEX_BOT.
 */
export const PM_WRITER = Object.freeze({ login: "jonghee1998", id: 129052128, type: "User" });
export function isTrustedPm(user) {
  return !!user && user.login === PM_WRITER.login && Number(user.id) === PM_WRITER.id && user.type === PM_WRITER.type;
}

/**
 * Complete PM revise-marker structures. Every field is anchored; a partial or free-text mention never matches.
 *  - `<!-- gpt-pm-followup:pr<N>:<sha40>[:<agent>]:revise:<round> -->`            (comment or issue body)
 *  - `<!-- gpt-pm-event-state:v1 pr<N>:<sha40>[:<agent>]:revise:<round> -->`       (comment or issue body)
 *  - a line `Dedupe pr<N>:<sha40>:<agent>:revise:<round>.` (separate revision-issue body, e.g. Issue #75)
 */
const PM_KEY = String.raw`pr(\d+):([a-f0-9]{40}):(?:([a-z][a-z-]*):)?revise:([1-9]\d*)`;
const PM_HTML_RE = new RegExp(String.raw`<!--\s*gpt-pm-(?:followup:|event-state:v1\s+)${PM_KEY}\s*-->`, "g");
const PM_DEDUPE_RE = new RegExp(String.raw`(?:^|[\s.])Dedupe\s+${PM_KEY}(?=[.\s]|$)`, "gm");

/** Structured PM revise markers in one authored item. Untrusted authors yield nothing (fail closed). */
export function pmReviseMarkers(item) {
  if (!isTrustedPm(item?.user)) return [];
  const body = item.body ?? "";
  const res = [...body.matchAll(PM_HTML_RE)];
  // The plain `Dedupe` form is accepted only in an issue body (where the PM writes separate revision issues).
  if (item.kind === "issue") res.push(...body.matchAll(PM_DEDUPE_RE));
  return res.map((m) => ({ pr: Number(m[1]), sha: m[2], agent: m[3], round: Number(m[4]) }));
}

/**
 * Existing GPT PM writer already handed off this exact PR+SHA (transition guard against two writers).
 * `items` are PR comments plus issue-side evidence (issue comments and issue bodies, including separate
 * revision issues). Only trusted-PM, structurally complete markers for exactly this PR and SHA count.
 */
export function gptWriterHandled(items, prNumber, sha) {
  return items.some((it) => pmReviseMarkers(it).some((m) => m.pr === prNumber && m.sha === sha));
}

/**
 * Decide the single mechanical handoff for a PR from live state.
 * @returns {{action:"noop", reason:string, detail?:object} | {action:"revise"|"release_ready", key:string, sha:string, agent?:string, linkedIssue?:number, codex:object}}
 */
export function decide({ pr, comments, linkedIssue, pmEvidence = [] }) {
  if (!pr || pr.state !== "open") return { action: "noop", reason: "pr_not_open" };
  const head = pr.head?.sha;
  const codex = latestCodexState(comments);
  if (!codex) return { action: "noop", reason: "no_trusted_codex_state" };
  if (codex.status !== "completed") return { action: "noop", reason: "codex_not_completed", detail: { status: codex.status } };
  if (codex.commitSha !== head) return { action: "noop", reason: "stale_codex_state", detail: { reviewed: codex.commitSha, head } };
  if (codex.hasUnresolvedFindings === false) {
    // Issue #156: code PASS alone is never total PASS; security must have completed clean on the same exact SHA.
    const sec = codex.security ?? { status: "not_run" };
    if (sec.status !== "completed") return { action: "noop", reason: "security_review_incomplete", detail: { security: sec.status } };
    if (sec.hasUnresolvedFindings !== false) return { action: "noop", reason: "security_findings_unresolved" };
    return { action: "release_ready", key: handoffKey(pr.number, head, "release-ready"), sha: head, codex };
  }
  if (gptWriterHandled([...comments, ...pmEvidence], pr.number, head)) return { action: "noop", reason: "gpt_writer_already_handled" };
  const refs = linkedIssueNumbers(pr);
  if (refs.length !== 1) return { action: "noop", reason: "linked_issue_ambiguous", detail: { refs } };
  if (!linkedIssue || linkedIssue.number !== refs[0]) return { action: "noop", reason: "linked_issue_unavailable", detail: { refs } };
  const agent = agentOf(linkedIssue);
  if (!agent) return { action: "noop", reason: "linked_issue_agent_ambiguous", detail: { issue: refs[0] } };
  return { action: "revise", key: handoffKey(pr.number, head, "revise"), sha: head, agent, linkedIssue: refs[0], codex };
}

const FOOTER = "\n\n---\n_Posted by the repository handoff coordinator (Issue #73). Mechanical record only — not an approval, merge or deploy._";

export function revisionIssue(plan, pr, repo) {
  const short = plan.sha.slice(0, 7);
  return {
    title: `PR${pr.number} revision: resolve Codex findings on ${short} (#${plan.linkedIssue})`,
    labels: [`agent:${plan.agent}`, "status:ready"],
    body: [
      markerFor(plan.key),
      `Revision for PR #${pr.number} (source Issue #${plan.linkedIssue}).`,
      "",
      `- Exact base: \`${pr.head.ref}@${plan.sha}\``,
      `- Codex state: ${plan.codex.url} (has_unresolved_findings=true on this exact SHA)`,
      `- Review threads: https://github.com/${repo}/pull/${pr.number}/files`,
      "",
      "Scope: resolve the unresolved Codex findings on that PR only. Open a separate PR, post ACK and completion, then request `@codex review` once on the new exact SHA.",
      "No main merge, deploy, production DB writes, secrets or paid APIs.",
    ].join("\n") + FOOTER,
  };
}

export function claimBody(plan, state, issue) {
  const marker = `<!-- handoff-coordinator:${MARKER_VERSION} ${plan.key} state=${state}${issue ? ` issue=${issue}` : ""} -->`;
  if (plan.action === "release_ready") {
    return `${marker}\nrelease-ready-for-validation — Codex reported no unresolved findings on exact head \`${plan.sha}\` (${plan.codex.url}). Next: PM validation. This is NOT approval, merge or deploy.${FOOTER}`;
  }
  return state === "done"
    ? `${marker}\nRevision handoff — Codex unresolved findings on exact head \`${plan.sha}\`. Revision issue #${issue} (agent:${plan.agent}, status:ready).${FOOTER}`
    : `${marker}\nRevision handoff claimed for exact head \`${plan.sha}\` — creating revision issue.${FOOTER}`;
}
