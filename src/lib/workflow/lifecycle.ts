// Evidence-based lifecycle + completion classification (Issue #99, refs #78/#94).
// Uses only existing evidence: issue state/body/labels, linked PR state/base/head, review headMatch, ACK.
// Never infers deployment/running state. `unknown` completion type is never final-complete.
import type { WorkQueueTask } from "../github/work-queue";
import type { IssueEvidence, PullEvidence } from "../github/evidence";

export type CompletionType = "deploy" | "integration" | "nondeploy" | "unknown";
export type LifecyclePhase = "remaining" | "reported" | "active" | "review" | "blocked" | "done" | "unknown";
export type Completion = "complete" | "deployment_pending" | "incomplete" | "unknown";
export type CloseReason = "completed" | "not_planned" | "duplicate" | "unknown";
export type ReviewState = "verified" | "stale" | "unverified" | "none";
export type MissingEvidence = "completion_type" | "merged_pr" | "main_merge" | "deployment" | "pr_association" | "issue_closed" | "integration_target" | "review_current" | "close_reason" | "open_pr";

export interface Lifecycle {
  phase: LifecyclePhase;
  completionType: CompletionType;
  completion: Completion;
  missingEvidence: MissingEvidence[];
  /** ACK = receipt reported only; execution is never verified from existing evidence. */
  receipt: "reported" | "none";
  /** What the visible "reported" state rests on: an actual ACK comment, only a status label (self-set), or nothing. */
  signal: "ack" | "label" | "none";
  execution: "unverified";
  /** Commits/PR prove work occurred, not that anything is currently running. */
  workOccurred: boolean;
  review: ReviewState;
  pr?: { number: number; state: PullEvidence["state"]; base: string; head: string };
}

const TYPES: CompletionType[] = ["deploy", "integration", "nondeploy", "unknown"];
/** Explicit `Completion type: <x>` line in the issue body. Missing, invalid or conflicting → unknown. */
export function parseCompletionType(body: string | null | undefined): CompletionType {
  const found = new Set<string>();
  for (const m of (body ?? "").matchAll(/^\s*[*_`>-]*\s*completion[ _-]?type\s*[*_`]*\s*[:=]\s*[*_`]*\s*([a-z-]+)/gim)) found.add(m[1].toLowerCase());
  if (found.size !== 1) return "unknown";
  const v = [...found][0] as CompletionType;
  return TYPES.includes(v) ? v : "unknown";
}

/** Explicit `Integration target: <branch>` line. Missing or conflicting → undefined (integration cannot complete). */
export function parseIntegrationTarget(body: string | null | undefined): string | undefined {
  const found = new Set<string>();
  for (const m of (body ?? "").matchAll(/^\s*[*_`>-]*\s*integration[ _-]?target\s*[*_`]*\s*[:=]\s*[*_`]*\s*([A-Za-z0-9_./-]+)/gim)) found.add(m[1]);
  return found.size === 1 ? [...found][0] : undefined;
}

export type PrPick = { kind: "none" } | { kind: "ambiguous" } | { kind: "pr"; pull: PullEvidence };
const explicit = (p: PullEvidence) => p.linkedBy.some(l => l === "title" || l === "body");
/** Tip(s) of a stacked chain: a PR is superseded when another candidate is based on its head branch. */
function chainTips(c: PullEvidence[]): PullEvidence[] {
  return c.filter(x => !c.some(y => y !== x && y.base === x.head && y.head !== x.head));
}
function pickAmong(c: PullEvidence[]): PrPick {
  if (c.length === 1) return { kind: "pr", pull: c[0] };
  const tips = chainTips(c);
  if (tips.length === 1) return { kind: "pr", pull: tips[0] };
  // Unrelated candidates: only an explicit association (PR title/body references this issue) can single one out.
  const pool = tips.length ? tips : c;
  const linked = pool.filter(explicit);
  return linked.length === 1 ? { kind: "pr", pull: linked[0] } : { kind: "ambiguous" };
}
/** Open PRs (current work) take precedence over merged history. Within a level: stacked-chain tip, then explicit
 *  association; never "latest by number". Anything still unprovable stays ambiguous (→ unknown). */
export function pickPull(pulls: PullEvidence[]): PrPick {
  const open = pulls.filter(p => p.state === "open");
  if (open.length) return pickAmong(open);
  const merged = pulls.filter(p => p.state === "merged");
  return merged.length ? pickAmong(merged) : { kind: "none" };
}

/** Integration boundary PR for target T: PRs delivering INTO T (base === T), else the PR that delivers T itself
 *  (head === T, e.g. the outer PR of a stack). Unrelated historical PRs are not candidates. */
export function pickIntegrationPull(pulls: PullEvidence[], target: string): PrPick | undefined {
  const into = pulls.filter(p => p.base === target && p.head !== target);
  const cand = into.length ? into : pulls.filter(p => p.head === target);
  return cand.length ? pickPull(cand) : undefined;
}
/** Stack members below the boundary PR (inner work): PRs whose head is the base of a member, transitively. */
export function innerStack(pulls: PullEvidence[], boundary: PullEvidence): PullEvidence[] {
  const out: PullEvidence[] = [], seen = new Set<PullEvidence>([boundary]);
  let frontier = [boundary];
  while (frontier.length) {
    const next = pulls.filter(y => !seen.has(y) && y.state !== "closed" && frontier.some(x => x.base === y.head && y.head !== x.head));
    next.forEach(y => seen.add(y)); out.push(...next); frontier = next;
  }
  return out;
}

const reviewOf = (p?: PullEvidence): ReviewState => {
  const d = p?.decision;
  if (!d || d.kind !== "approve") return "none";
  return d.headMatch === "exact" ? "verified" : d.headMatch === "stale" ? "stale" : "unverified";
};

export function classify(task: WorkQueueTask, proof: IssueEvidence | undefined, isDepDone: (id: string) => boolean): Lifecycle {
  const completionType = parseCompletionType(task.description);
  const target = parseIntegrationTarget(task.description);
  const status = task.status.replace(/^status:/, "");
  const closed = task.issueState === "closed" || proof?.state === "closed";
  const pulls = proof?.pulls ?? [];
  const bounded = completionType === "integration" && target ? pickIntegrationPull(pulls, target) : undefined;
  const pick = bounded ?? pickPull(pulls);
  const pull = pick.kind === "pr" ? pick.pull : undefined;
  // For target-bound integration only the boundary PR's stack is "current work"; unrelated PRs do not block.
  const inner = bounded && pull ? innerStack(pulls, pull) : [];
  const openPr = bounded ? (pull?.state === "open" || inner.some(p => p.state === "open")) : pulls.some(p => p.state === "open");
  const review = reviewOf(pull);
  const missing: MissingEvidence[] = [];
  if (completionType === "unknown") missing.push("completion_type");
  if (pick.kind === "ambiguous") missing.push("pr_association");

  let completion: Completion = "incomplete";
  if (completionType === "unknown" || pick.kind === "ambiguous") completion = "unknown";
  else if (completionType === "nondeploy") {
    // Closing is acceptance only when closed as completed and no current work (open PR) is unresolved. Fail closed.
    if (!closed) missing.push("issue_closed");
    else if (openPr) missing.push("open_pr");
    else if (task.stateReason === "completed") completion = "complete";
    else { missing.push("close_reason"); if (!task.stateReason || task.stateReason === "unknown") completion = "unknown"; }
  } else if (completionType === "integration") {
    // Integration FACT (merged into the intended target) is not acceptance: it also needs a current-head approval.
    if (!target) { missing.push("integration_target"); completion = "unknown"; }
    else if (bounded && pull?.state === "merged" && inner.some(p => p.state === "open")) missing.push("open_pr");
    else if (pull?.state !== "merged" || (!bounded && pull.base !== target) || (bounded && pull.base !== target && pull.head !== target)) missing.push("merged_pr");
    else if (review !== "verified") missing.push("review_current");
    else completion = "complete";
  } else {
    // deploy: merge into main is necessary, deployment evidence is not collected → never complete here.
    if (pull?.state === "merged" && pull.base === "main") { completion = "deployment_pending"; missing.push("deployment"); }
    else { missing.push(pull?.state === "merged" ? "main_merge" : "merged_pr"); if (pull?.state === "merged") missing.push("deployment"); }
  }

  const receipt = proof?.acks.length ? "reported" as const : "none" as const;
  const signal = receipt === "reported" ? "ack" as const : status === "in-progress" ? "label" as const : "none" as const;
  let phase: LifecyclePhase;
  if (completion === "complete") phase = "done";
  else if (completion === "deployment_pending") phase = "review";
  else if (closed) phase = "unknown"; // closed but not proven complete: never "done"
  else if (status === "blocked") phase = "blocked";
  else if (status === "review" || status === "done") phase = "review";
  // A status label or ACK is a self-report: receipt reported / execution unverified. "active" needs runtime proof,
  // which this evidence set never contains, so it is not derivable here.
  else if (status === "in-progress" || (receipt === "reported" && ["ready", "queued", "backlog"].includes(status))) phase = "reported";
  else phase = ["ready", "queued", "backlog"].includes(status) ? "remaining" : "unknown";
  if (task.dependsOn.some(id => !isDepDone(id)) && phase !== "done" && phase !== "review") phase = "blocked";

  return {
    phase, completionType, completion, missingEvidence: missing,
    receipt, signal, execution: "unverified",
    workOccurred: pulls.length > 0,
    review,
    ...(pull ? { pr: { number: pull.number, state: pull.state, base: pull.base, head: pull.headSha } } : {}),
  };
}

export const COMPLETION_LABEL: Record<Completion, string> = { complete: "완료 기준 충족", deployment_pending: "배포 확인 대기", incomplete: "완료 기준 미충족", unknown: "완료 기준 확인되지 않음" };

/** Visible wording: a status label alone is NOT a reported receipt. */
export const SIGNAL_LABEL: Record<"ack" | "label", string> = { ack: "접수 보고됨 · 실행 미확인", label: "상태 라벨만 확인됨 · 접수 보고 없음 · 실행 미확인" };

export interface ProjectRollup { done: number; active: number; reported: number; remaining: number; stage: string }
/** Project complete only when every task meets its explicit completion criteria. */
export function rollup(phases: { phase: LifecyclePhase; completion: Completion; signal?: Lifecycle["signal"] }[]): ProjectRollup {
  const done = phases.filter(t => t.completion === "complete").length;
  const active = phases.filter(t => t.phase === "active" || t.phase === "review").length;
  const reported = phases.filter(t => t.phase === "reported").length;
  const stage = phases.length && done === phases.length ? "업무 완료"
    : phases.some(t => t.phase === "blocked") ? "확인·도움 필요"
    : phases.some(t => t.completion === "deployment_pending") ? "배포 확인 대기"
    : phases.some(t => t.phase === "review") ? "검수 중" : phases.some(t => t.phase === "active") ? "진행 중"
    : reported ? SIGNAL_LABEL[phases.some(t => t.phase === "reported" && t.signal === "ack") ? "ack" : "label"]
    : phases.some(t => t.completion === "unknown" && t.phase === "unknown") ? "확인 필요" : "시작 준비";
  return { done, active, reported, remaining: phases.length - done, stage };
}
