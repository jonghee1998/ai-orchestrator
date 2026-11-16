// P1-a (#98) — evidence-based lifecycle. A status label, a closed issue, an ACK, a commit or a PR is NOT
// completion by itself. Completion requires evidence that matches the task's declared completion type.
// CI / deployment data is not collected here: without it, deployment stays "unverifiable".
import type { IssueEvidence, PullEvidence } from "../github/evidence";

export type CompletionType = "deploy" | "integration" | "nondeploy" | "unknown";
export type LifecyclePhase =
  | "not_started" | "received" | "in_progress" | "review" | "stale_review" | "blocked"
  | "integrated" | "deploy_pending" | "completed" | "closed_unverified" | "unverifiable";
export const LIFECYCLE_LABEL: Record<LifecyclePhase, string> = {
  not_started: "시작 대기", received: "수신 보고 · 실행 미확인", in_progress: "진행 중 (라벨 기준)", review: "검수·결정 필요",
  stale_review: "검수 미완료 (이전 SHA 기준)", blocked: "도움 필요", integrated: "통합 완료 (운영 완료 아님)",
  deploy_pending: "배포 대기", completed: "완료", closed_unverified: "종료됨 · 완료유형 미확인", unverifiable: "확인 불가",
};
export interface Lifecycle { phase: LifecyclePhase; label: string; completionType: CompletionType; missingEvidence: string[]; complete: boolean }
export interface LifecycleInput {
  /** Issue body; completion type / criteria are read from it. */
  description?: string; labels?: string[]; status: string; issueState?: "open" | "closed";
  evidence?: IssueEvidence;
  /** Explicit deployment proof. This module never collects it; absent means unverified. */
  deployVerified?: boolean;
  /** Integration branch names that count as production (default main/master). */
  productionBranches?: string[];
}

const TYPES = ["deploy", "integration", "nondeploy"] as const;
/** `완료유형: deploy` / `Completion type: integration` in the body, or label `completion:<type>`. Anything else → unknown. */
export function completionTypeOf(description?: string, labels: string[] = []): CompletionType {
  const found = new Set<CompletionType>();
  for (const l of labels) { const m = /^completion:(.+)$/.exec(l); if (m && (TYPES as readonly string[]).includes(m[1])) found.add(m[1] as CompletionType); }
  for (const m of (description ?? "").matchAll(/^\s*(?:완료\s*유형|completion\s*type)\s*[:：]\s*(deploy|integration|nondeploy)\s*$/gim)) found.add(m[1].toLowerCase() as CompletionType);
  return found.size === 1 ? [...found][0] : "unknown";
}
/** An explicit, non-empty completion criterion line (`완료 조건:` / `Done when:`). */
export const hasExplicitCriteria = (description?: string) => /^\s*(?:완료\s*(?:조건|기준)|done\s*when|completion\s*criteria)\s*[:：]\s*\S/im.test(description ?? "");

/** Current PR for an issue: open PRs / explicit links win; ambiguity → undefined (never guessed). Past merges are history. */
export function currentPull(pulls: PullEvidence[]): { pull?: PullEvidence; ambiguous: boolean } {
  const open = pulls.filter(p => p.state === "open");
  const pool = open.length ? open : pulls.filter(p => p.state === "merged");
  if (pool.length <= 1) return { pull: pool[0], ambiguous: false };
  const explicit = pool.filter(p => p.linkedBy.some(l => l === "issue-body" || l === "issue-comment"));
  return explicit.length === 1 ? { pull: explicit[0], ambiguous: false } : { ambiguous: true };
}

export function lifecycleOf(t: LifecycleInput): Lifecycle {
  const completionType = completionTypeOf(t.description, t.labels);
  const prod = t.productionBranches ?? ["main", "master"];
  const ev = t.evidence;
  const closed = t.issueState === "closed" || ev?.state === "closed";
  const mk = (phase: LifecyclePhase, missingEvidence: string[] = [], complete = false): Lifecycle => ({ phase, label: LIFECYCLE_LABEL[phase], completionType, missingEvidence, complete });
  const { pull, ambiguous } = ev ? currentPull(ev.pulls) : { pull: undefined, ambiguous: false };
  const merged = pull?.state === "merged";
  const mergedToProd = merged && prod.includes(pull!.base);

  if (ambiguous) return mk("unverifiable", ["연결된 PR이 여러 개이며 현재 PR을 특정할 수 없음"]);
  if (merged) {
    if (completionType === "unknown") return mk(closed ? "closed_unverified" : "unverifiable", ["완료유형(deploy|integration|nondeploy) 미지정"]);
    if (completionType === "nondeploy") return nondeploy();
    if (completionType === "integration") return mk("integrated", [], true);
    // deploy
    if (!mergedToProd) return mk("integrated", ["main 병합", "배포 확인 증거"]);
    return t.deployVerified ? mk("completed", [], true) : mk("deploy_pending", ["배포 확인 증거"]);
  }
  if (closed) {
    if (completionType === "unknown") return mk("closed_unverified", ["완료유형(deploy|integration|nondeploy) 미지정"]);
    if (completionType === "nondeploy") return nondeploy();
    return mk("unverifiable", [completionType === "deploy" ? "병합 및 배포 확인 증거" : "통합 브랜치 병합 증거"]);
  }
  if (pull?.state === "open") {
    if (pull.draft) return mk("in_progress", ["현재 실행 증거 (PR은 과거 작업 증거)"]);
    const d = pull.decision;
    if (d && d.kind === "approve" && d.headMatch === "exact") return mk("review", ["병합 증거"]);
    if (d && d.headMatch !== "exact") return mk("stale_review", [`현재 head ${pull.headSha.slice(0, 7)} 기준 검수`]);
    return mk("review", ["현재 head 기준 검수 결과"]);
  }
  const status = t.status.replace(/^status:/, "");
  if (status === "blocked") return mk("blocked", ["차단 해소"]);
  if (status === "review" || status === "done") return mk("review", ["검수·완료 증거"]);
  if (status === "in-progress") return mk("in_progress", ["현재 실행 증거"]);
  if (ev && ev.acks.length) return mk("received", ["실행 시작 증거"]);
  if (["ready", "queued", "backlog"].includes(status)) return mk("not_started", []);
  return mk("unverifiable", ["상태 정보"]);

  function nondeploy(): Lifecycle {
    const missing: string[] = [];
    if (!hasExplicitCriteria(t.description)) missing.push("명시적 완료 기준");
    if (!closed) missing.push("이슈 종료");
    if (!ev?.completions.length) missing.push("완료 기준 충족 보고");
    return missing.length ? mk("unverifiable", missing) : mk("completed", [], true);
  }
}

/** A project is complete only when every task meets its own completion criterion. */
export const projectComplete = (items: Lifecycle[]) => items.length > 0 && items.every(l => l.complete);
