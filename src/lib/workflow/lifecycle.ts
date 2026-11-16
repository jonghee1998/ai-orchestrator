// Evidence-based lifecycle + completion classification (Issue #99, refs #78/#94).
// Uses only existing evidence: issue state/body/labels, linked PR state/base/head, review headMatch, ACK.
// Never infers deployment/running state. `unknown` completion type is never final-complete.
import type { WorkQueueTask } from "../github/work-queue";
import type { IssueEvidence, PullEvidence } from "../github/evidence";

export type CompletionType = "deploy" | "integration" | "nondeploy" | "unknown";
export type LifecyclePhase = "remaining" | "active" | "review" | "blocked" | "done" | "unknown";
export type Completion = "complete" | "deployment_pending" | "incomplete" | "unknown";
export type ReviewState = "verified" | "stale" | "unverified" | "none";
export type MissingEvidence = "completion_type" | "merged_pr" | "main_merge" | "deployment" | "pr_association" | "issue_closed";

export interface Lifecycle {
  phase: LifecyclePhase;
  completionType: CompletionType;
  completion: Completion;
  missingEvidence: MissingEvidence[];
  /** ACK = receipt reported only; execution is never verified from existing evidence. */
  receipt: "reported" | "none";
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

export type PrPick = { kind: "none" } | { kind: "ambiguous" } | { kind: "pr"; pull: PullEvidence };
/** Open PR takes precedence over historical merged PR. Several candidates at the same level → ambiguous. */
export function pickPull(pulls: PullEvidence[]): PrPick {
  const open = pulls.filter(p => p.state === "open");
  if (open.length) return open.length === 1 ? { kind: "pr", pull: open[0] } : { kind: "ambiguous" };
  const merged = pulls.filter(p => p.state === "merged");
  if (merged.length) return merged.length === 1 ? { kind: "pr", pull: merged[0] } : { kind: "ambiguous" };
  return { kind: "none" };
}

const reviewOf = (p?: PullEvidence): ReviewState => {
  const d = p?.decision;
  if (!d || d.kind !== "approve") return "none";
  return d.headMatch === "exact" ? "verified" : d.headMatch === "stale" ? "stale" : "unverified";
};

export function classify(task: WorkQueueTask, proof: IssueEvidence | undefined, isDepDone: (id: string) => boolean): Lifecycle {
  const completionType = parseCompletionType(task.description);
  const status = task.status.replace(/^status:/, "");
  const closed = task.issueState === "closed" || proof?.state === "closed";
  const pick = pickPull(proof?.pulls ?? []);
  const pull = pick.kind === "pr" ? pick.pull : undefined;
  const missing: MissingEvidence[] = [];
  if (completionType === "unknown") missing.push("completion_type");
  if (pick.kind === "ambiguous") missing.push("pr_association");

  let completion: Completion = "incomplete";
  if (completionType === "unknown" || pick.kind === "ambiguous") completion = "unknown";
  else if (completionType === "nondeploy") {
    if (closed || pull?.state === "merged") completion = "complete"; else missing.push("issue_closed");
  } else if (completionType === "integration") {
    if (pull?.state === "merged") completion = "complete"; else missing.push("merged_pr");
  } else {
    // deploy: merge into main is necessary, deployment evidence is not collected → never complete here.
    if (pull?.state === "merged" && pull.base === "main") { completion = "deployment_pending"; missing.push("deployment"); }
    else { missing.push(pull?.state === "merged" ? "main_merge" : "merged_pr"); if (pull?.state === "merged") missing.push("deployment"); }
  }

  let phase: LifecyclePhase;
  if (completion === "complete") phase = "done";
  else if (completion === "deployment_pending") phase = "review";
  else if (closed) phase = "unknown"; // closed but not proven complete: never "done"
  else phase = status === "blocked" ? "blocked" : status === "review" || status === "done" ? "review" : status === "in-progress" ? "active" : ["ready", "queued", "backlog"].includes(status) ? "remaining" : "unknown";
  if (task.dependsOn.some(id => !isDepDone(id)) && phase !== "done" && phase !== "review") phase = "blocked";

  return {
    phase, completionType, completion, missingEvidence: missing,
    receipt: proof?.acks.length ? "reported" : "none", execution: "unverified",
    workOccurred: !!pull || (proof?.pulls.length ?? 0) > 0,
    review: reviewOf(pull),
    ...(pull ? { pr: { number: pull.number, state: pull.state, base: pull.base, head: pull.headSha } } : {}),
  };
}

export const COMPLETION_LABEL: Record<Completion, string> = { complete: "완료 기준 충족", deployment_pending: "배포 확인 대기", incomplete: "완료 기준 미충족", unknown: "완료 기준 확인되지 않음" };

export interface ProjectRollup { done: number; active: number; remaining: number; stage: string }
/** Project complete only when every task meets its explicit completion criteria. */
export function rollup(phases: { phase: LifecyclePhase; completion: Completion }[]): ProjectRollup {
  const done = phases.filter(t => t.completion === "complete").length;
  const active = phases.filter(t => t.phase === "active" || t.phase === "review").length;
  const stage = phases.length && done === phases.length ? "업무 완료"
    : phases.some(t => t.phase === "blocked") ? "확인·도움 필요"
    : phases.some(t => t.completion === "deployment_pending") ? "배포 확인 대기"
    : phases.some(t => t.phase === "review") ? "검수 중" : active ? "진행 중"
    : phases.some(t => t.completion === "unknown" && t.phase === "unknown") ? "확인 필요" : "시작 준비";
  return { done, active, remaining: phases.length - done, stage };
}
