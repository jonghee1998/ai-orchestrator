// Evidence-based lifecycle + completion classification (Issue #99, refs #78/#94).
// Uses only existing evidence: issue state/body/labels, linked PR state/base/head, review headMatch, ACK.
// Never infers deployment/running state. `unknown` completion type is never final-complete.
import type { WorkQueueTask } from "../github/work-queue";
import type { Acceptance, IssueEvidence, PullEvidence, StackRef } from "../github/evidence-types";

export type CompletionType = "deploy" | "integration" | "nondeploy" | "unknown";
export type LifecyclePhase = "remaining" | "reported" | "active" | "review" | "blocked" | "done" | "unknown";
export type Completion = "complete" | "deployment_pending" | "incomplete" | "unknown";
export type CloseReason = "completed" | "not_planned" | "duplicate" | "unknown";
/** verified = OFFICIAL non-author GitHub approval on the exact head.
 *  pm-accepted = PM self-reported acceptance marker on the exact head (NOT GitHub approval, NOT authentication).
 *  comment-only = a plain approve-looking comment/review: never acceptance.
 *  Neither verified nor pm-accepted authorizes execution/merge/deploy (see Lifecycle.authorizesExecution). */
export type ReviewState = "verified" | "pm-accepted" | "stale" | "unverified" | "comment-only" | "none";
export type MissingEvidence = "completion_type" | "merged_pr" | "main_merge" | "deployment" | "pr_association" | "issue_closed" | "integration_target" | "review_current" | "close_reason" | "open_pr" | "acceptance_current" | "stranded_stack" | "merge_order" | "evidence_partial";

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
  /** Always false: lifecycle completion, a PM marker or an official review are evidence only — never execution authorization. */
  authorizesExecution: false;
  pr?: { number: number; state: PullEvidence["state"]; base: string; /** branch ref */ head: string; headSha: string };
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
const explicit = (p: PullEvidence) => p.linkedBy.some(l => l === "title" || l === "body" || l === "issue-body");
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
/** Display pick for non-integration types. Open PRs (current work) take precedence over merged history. */
export function pickPull(pulls: PullEvidence[]): PrPick {
  const open = pulls.filter(p => p.state === "open");
  if (open.length) return pickAmong(open);
  const merged = pulls.filter(p => p.state === "merged");
  return merged.length ? pickAmong(merged) : { kind: "none" };
}

/** I1/I2 universe: explicitly linked PRs (title/body/issue-body — an issue-comment mention alone is inference) plus every
 *  repo PR stacked on them (Q.base === P.head, transitive; computed in evidence over ALL repo PRs). Without `proof.stack`
 *  (hand-built evidence) only the explicit linked PRs are known. */
export function universe(proof: IssueEvidence | undefined): StackRef[] {
  const byNum = new Map<number, StackRef>();
  for (const p of proof?.pulls ?? []) if (explicit(p)) byNum.set(p.number, {
    number: p.number, state: p.state, base: p.base, head: p.head, headSha: p.headSha, mergedAt: p.mergedAt, explicit: true,
    officialApproved: p.officialApproval?.sha.toLowerCase() === p.headSha.toLowerCase() || undefined,
  });
  for (const r of proof?.stack ?? []) if (!byNum.has(r.number)) byNum.set(r.number, r);
  return [...byNum.values()].sort((a, b) => a.number - b.number);
}
/** Boundary PRs for target T. Strictly base === T; a PR with head === T is OUTGOING from T and never counts. */
export const boundaries = (u: StackRef[], target: string) => u.filter(p => p.base === target && p.head !== target && p.state !== "closed");
/** Closed-unmerged PRs into T: never a boundary (nothing delivered), but their live descendants are stranded (R9). */
const closedBoundaries = (u: StackRef[], target: string) => u.filter(p => p.base === target && p.head !== target && p.state === "closed");
/** PRs stacked on `root` (Q.base === parent.head, transitive) with their parent. Cycle-safe. */
export function upstack(u: StackRef[], root: StackRef): { q: StackRef; parent: StackRef }[] {
  const out: { q: StackRef; parent: StackRef }[] = [], seen = new Set<number>([root.number]);
  let frontier = [root];
  while (frontier.length) {
    const next: StackRef[] = [];
    for (const parent of frontier) for (const q of u) if (!seen.has(q.number) && q.base === parent.head && q.head !== parent.head) { seen.add(q.number); out.push({ q, parent }); next.push(q); }
    frontier = next;
  }
  return out;
}
const ts = (s?: string) => (s ? Date.parse(s) : NaN);
/** PM acceptance (self-reported marker) or official non-author approval, bound to B's current head SHA and target. */
function acceptanceOf(b: StackRef, target: string, acc: Acceptance[]): "current" | "stale" | "none" {
  const s = acceptanceSources(b, target, acc);
  return s.pm || s.official ? "current" : s.stale ? "stale" : "none";
}
/** PM self-reported marker and official review kept apart; they are never merged into one "verified" signal. */
function acceptanceSources(b: StackRef, target: string, acc: Acceptance[]): { pm: boolean; official: boolean; stale: boolean } {
  const mine = acc.filter(a => a.pr === b.number && a.target === target);
  const pm = mine.some(a => a.sha.toLowerCase() === b.headSha.toLowerCase());
  return { pm, official: !!b.officialApproved, stale: mine.length > 0 && !pm };
}

const reviewFor = (pull: PullEvidence | undefined, ref: StackRef | undefined, target: string | undefined, acc: Acceptance[]): ReviewState => {
  if (ref?.officialApproved) return "verified";
  if (ref && target) { const a = acceptanceSources(ref, target, acc); if (a.pm) return "pm-accepted"; if (a.stale) return "stale"; }
  const d = pull?.decision;
  if (!d || d.kind !== "approve") return "none";
  // A plain comment/review "approval" is never acceptance (A5): at most a comment-only signal.
  return d.headMatch === "stale" ? "stale" : d.headMatch === "unknown" ? "unverified" : "comment-only";
};

type Pending = Exclude<MissingEvidence, "completion_type" | "integration_target" | "pr_association" | "issue_closed">;
/** Integration into T. Returns the missing evidence and whether merge ordering could not be established. */
function integration(u: StackRef[], target: string, acc: Acceptance[]): { missing: Pending[]; orderUnknown: boolean; primary?: StackRef } {
  const bd = boundaries(u, target);
  const missing = new Set<Pending>(); let orderUnknown = false;
  if (!bd.length) missing.add("merged_pr");
  // R9 at the boundary: a closed-unmerged boundary PR delivered nothing, so any live (open/merged) descendant is stranded.
  for (const b of closedBoundaries(u, target)) if (upstack(u, b).some(({ q }) => q.state !== "closed")) missing.add("stranded_stack");
  if (!bd.length) return { missing: [...missing], orderUnknown: false };
  for (const b of bd) {
    if (b.state === "open") missing.add("merged_pr");
    for (const { q, parent } of upstack(u, b)) {
      // R9: a closed-unmerged ancestor never delivered its branch; any live (open/merged) descendant is stranded, however deep.
      if (parent.state === "closed" && q.state !== "closed") missing.add("stranded_stack");
      if (q.state === "open") missing.add("open_pr");
      else if (q.state === "merged" && parent.state === "merged") {
        const a = ts(q.mergedAt), p = ts(parent.mergedAt);
        if (Number.isNaN(a) || Number.isNaN(p) || a === p) { missing.add("merge_order"); orderUnknown = true; }
        else if (a > p) missing.add("stranded_stack"); // merged into its base branch AFTER that branch was delivered: not in T
      }
    }
    if (b.state === "merged" && acceptanceOf(b, target, acc) !== "current") missing.add("acceptance_current");
  }
  const primary = bd.find(b => b.state === "open") ?? [...bd].sort((a, b) => b.number - a.number)[0];
  return { missing: [...missing], orderUnknown, primary };
}

const CANCELLED = new Set(["not_planned", "duplicate"]);

/** `evidenceGap`: the evidence collection is missing/errored/truncated, so absence of a PR proves nothing (Issue #119). */
export function classify(task: Pick<WorkQueueTask, "status" | "dependsOn" | "issueState" | "stateReason" | "description">, proof: IssueEvidence | undefined, isDepDone: (id: string) => boolean, evidenceGap = false): Lifecycle {
  const completionType = parseCompletionType(task.description);
  const target = parseIntegrationTarget(task.description);
  const status = task.status.replace(/^status:/, "");
  const closed = task.issueState === "closed" || proof?.state === "closed";
  const cancelled = closed && !!task.stateReason && CANCELLED.has(task.stateReason);
  const pulls = proof?.pulls ?? [];
  const u = universe(proof);
  const acc = proof?.acceptances ?? [];
  // Fail closed: for nondeploy, "no open PR" can only be concluded from evidence that actually covers this issue.
  const partial = !!proof?.partial?.length || evidenceGap || (completionType === "nondeploy" && !proof);
  const missing: MissingEvidence[] = [];
  if (completionType === "unknown") missing.push("completion_type");

  let completion: Completion = "incomplete";
  let primary: StackRef | undefined;
  if (completionType === "unknown") completion = "unknown";
  else if (cancelled) { missing.push("close_reason"); } // I5: cancelled work is never complete, for every type
  else if (completionType === "integration" && !target) { missing.push("integration_target"); completion = "unknown"; }
  else if (partial) { missing.push("evidence_partial"); completion = "unknown"; } // I6
  else if (completionType === "nondeploy") {
    const openPr = pulls.some(p => p.state === "open") || u.some(p => p.state === "open");
    // Closing is acceptance only when closed as completed and no current work (open PR) is unresolved. Fail closed.
    if (!closed) missing.push("issue_closed");
    else if (openPr) missing.push("open_pr");
    else if (task.stateReason === "completed") completion = "complete";
    else { missing.push("close_reason"); if (!task.stateReason || task.stateReason === "unknown") completion = "unknown"; }
  } else if (completionType === "integration") {
    const r = integration(u, target!, acc);
    primary = r.primary; missing.push(...r.missing);
    if (!r.missing.length) completion = "complete";
    else if (r.orderUnknown && r.missing.every(m => m === "merge_order")) completion = "unknown";
  } else {
    // deploy (I7): boundary is a merged PR into main among explicit/up-stack PRs. Open follow-ups and feature-based tips
    // do not hide it. Deployment evidence is not collected → never complete here.
    const main = u.filter(p => p.base === "main" && p.head !== "main" && p.state === "merged");
    primary = main[main.length - 1] ?? u.find(p => p.state === "open") ?? u[u.length - 1];
    if (main.length) { completion = "deployment_pending"; missing.push("deployment"); }
    else { missing.push(u.some(p => p.state === "merged") ? "main_merge" : "merged_pr"); if (u.some(p => p.state === "merged")) missing.push("deployment"); }
  }
  const pull = primary ? pulls.find(p => p.number === primary!.number) : completionType === "integration" || completionType === "deploy" ? undefined : (() => { const k = pickPull(pulls); return k.kind === "pr" ? k.pull : undefined; })();
  const review = reviewFor(pull, primary, target, acc);
  const prRef = primary ?? (pull ? { number: pull.number, state: pull.state, base: pull.base, head: pull.head, headSha: pull.headSha } : undefined);

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
    phase, completionType, completion, missingEvidence: [...new Set(missing)],
    receipt, signal, execution: "unverified",
    workOccurred: pulls.length > 0,
    review, authorizesExecution: false,
    // `head` is the branch REF (same meaning as PullEvidence.head); the commit is `headSha`.
    ...(prRef ? { pr: { number: prRef.number, state: prRef.state, base: prRef.base, head: prRef.head, headSha: prRef.headSha } } : {}),
  };
}

export const COMPLETION_LABEL: Record<Completion, string> = { complete: "완료 기준 충족", deployment_pending: "배포 확인 대기", incomplete: "완료 기준 미충족", unknown: "완료 기준 확인되지 않음" };

/** Visible wording: a status label alone is NOT a reported receipt. */
export const SIGNAL_LABEL: Record<"ack" | "label", string> = { ack: "접수 보고됨 · 실행 미확인", label: "상태 라벨만 확인됨 · 접수 보고 없음 · 실행 미확인" };

export interface ProjectRollup { /** Complete per criteria. May rest on a PM self-reported marker. */ done: number; /** Tasks in `done` that lack an official non-author review (PM self-report or issue closure only). */ doneWithoutOfficialReview: number; active: number; reported: number; remaining: number; stage: string }
/** Project complete only when every task meets its explicit completion criteria. */
export function rollup(phases: { phase: LifecyclePhase; completion: Completion; signal?: Lifecycle["signal"]; review?: ReviewState }[]): ProjectRollup {
  const done = phases.filter(t => t.completion === "complete").length;
  const doneWithoutOfficialReview = phases.filter(t => t.completion === "complete" && t.review !== "verified").length;
  const active = phases.filter(t => t.phase === "active" || t.phase === "review").length;
  const reported = phases.filter(t => t.phase === "reported").length;
  const stage = phases.length && done === phases.length ? "업무 완료"
    : phases.some(t => t.phase === "blocked") ? "확인·도움 필요"
    : phases.some(t => t.completion === "deployment_pending") ? "배포 확인 대기"
    : phases.some(t => t.phase === "review") ? "검수 중" : phases.some(t => t.phase === "active") ? "진행 중"
    : reported ? SIGNAL_LABEL[phases.some(t => t.phase === "reported" && t.signal === "ack") ? "ack" : "label"]
    : phases.some(t => t.completion === "unknown" && t.phase === "unknown") ? "확인 필요" : "시작 준비";
  return { done, doneWithoutOfficialReview, active, reported, remaining: phases.length - done, stage };
}
