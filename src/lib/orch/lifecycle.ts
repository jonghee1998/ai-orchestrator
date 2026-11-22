// Work lifecycle (stages 1~5) and where a run / plan / idea currently sits in it.
// Pure: imports only model.ts (pure), safe for client components.
import { PLAN_REVIEW_ROUNDS, type Idea, type OrchRun, type PendingPlan } from "./model";

export type LifecycleStage = 1 | 2 | 3 | 4 | 5;

export interface LifecycleSub {
  id: string;
  title: string;
}

export interface LifecycleStep {
  n: LifecycleStage;
  title: string;
  sub: LifecycleSub[];
}

const subs = (n: number, titles: string[]): LifecycleSub[] => titles.map((title, i) => ({ id: `${n}.${i + 1}`, title }));

export const LIFECYCLE: readonly LifecycleStep[] = [
  { n: 1, title: "검토", sub: subs(1, ["접수", "PM 분석", "Codex 평가", "의견 종합", "가치·우선순위", "개발 확정"]) },
  {
    n: 2, title: "계획",
    sub: subs(2, ["코드 분석", "범위 정의", "단계 분할", "완료 조건", "모델·반영 정책", "계획 감사", "재감사", "사용자 승인", "개발 시작"]),
  },
  {
    n: 3, title: "개발",
    sub: subs(3, [
      "단계 확인", "AI 가용 확인", "모델 선택", "브랜치 준비", "코드 분석", "스킬 활용", "구현", "자체 검증",
      "PR 생성", "독립 검수", "CI", "종합 판정", "자동 수정", "재검수", "단계 반영", "다음 단계",
    ]),
  },
  { n: 4, title: "통합", sub: subs(4, ["완료 확인", "최종 PR", "통합 CI", "충돌 처리", "위험도 판단", "완공 보고서", "반영·승인", "완료·알림"]) },
  { n: 5, title: "배포", sub: subs(5, ["업데이트 집계", "배포 조건", "Vercel 배포", "상황판 갱신", "사용량 갱신", "PM 점검", "자동 복구", "결정 알림"]) },
];

export interface LifecyclePosition {
  stage: LifecycleStage;
  /** LIFECYCLE sub id, e.g. '3.10'. */
  sub: string;
  label: string;
}

const pos = (sub: string, label: string): LifecyclePosition => ({ stage: Number(sub.split(".")[0]) as LifecycleStage, sub, label });

/** 'Step k/N', or null when the run has no current step. */
function stepOf(run: OrchRun): string | null {
  return typeof run.step === "number" && run.step > 0 ? `Step ${run.step}/${run.total}` : null;
}

const join = (...parts: (string | null)[]) => parts.filter((p): p is string => !!p).join(" · ");

/** Lifecycle position of a run. Cancelled → null (left out of the flow list). Unknown status → treated like waiting. */
export function runPosition(run: OrchRun): LifecyclePosition | null {
  const status = run?.status as string;
  const step = run ? stepOf(run) : null;
  switch (status) {
    case "cancelled":
      return null;
    case "implementing":
      return pos("3.7", join("구현 중", step));
    case "reviewing":
      return pos("3.10", join("검수 중", step));
    case "fixing":
      return pos("3.13", join("자동 수정 중", step, `수정 ${run.retries ?? 0}/${run.maxRetries ?? 3}`));
    case "finalizing":
      return pos("4.3", "통합 검사 중");
    case "awaiting_merge":
      return pos("4.7", "반영 승인 대기");
    case "done":
      return pos("4.8", "완료");
    case "blocked": {
      // The engine does not keep the status before 'blocked'; guess from steps.
      const steps = Array.isArray(run.steps) ? run.steps : [];
      if (steps.length > 0 && steps.every((s) => s.state === "passed")) return pos("4.4", "멈춤(통합)");
      const k = typeof run.step === "number" && run.step > 0 ? run.step : steps.find((s) => s.state !== "passed")?.id ?? null;
      return pos("3.12", k !== null ? `멈춤(Step ${k}) · Step ${k}/${run.total}` : "멈춤");
    }
    case "waiting":
    default:
      return pos("2.9", run?.held ? "ON/OFF 대기" : "시작 대기");
  }
}

/** Lifecycle position of a plan waiting for audit / approval. */
export function planPosition(plan: PendingPlan): LifecyclePosition {
  const review = plan?.review;
  if (!review) return pos("2.6", "감사 대기");
  if (review.stale || review.verdict === "ERROR") return pos("2.6", "재감사 대기");
  if (review.verdict === "REVISE") return pos("2.7", `수정 필요 ${review.round}/${PLAN_REVIEW_ROUNDS}`);
  if (review.verdict === "OK") return pos("2.8", "승인 대기");
  return pos("2.6", "재감사 대기");
}

/** Lifecycle position of an idea under review. Unknown status → 1.2. */
export function ideaPosition(idea: Idea): LifecyclePosition {
  switch (idea?.status as string) {
    case "collecting":
      return pos("1.3", "의견 수집 중");
    case "codex_pending":
      return pos("1.3", "Codex 대기");
    case "done":
      return pos("1.5", "의견 완료");
    case "stale":
      return pos("1.2", "다시 분석 필요");
    default:
      return pos("1.2", "분석 중");
  }
}

export type FlowEntry =
  | { kind: "run"; key: string; number: number; url: string; goal: string; pos: LifecyclePosition; run: OrchRun }
  | { kind: "plan" | "idea"; key: string; number: number; url: string; goal: string; pos: LifecyclePosition };

const subRank = (p: LifecyclePosition) => Number(p.sub.split(".")[1] ?? 0);

/**
 * '작업 흐름' rows for one project: active runs (not done / cancelled), plans waiting for audit / approval and
 * ideas still under review (open, not 'done'), ordered by position 5→1 (later sub first within a stage).
 */
export function flowEntries(v: { runs: OrchRun[]; plans: PendingPlan[]; ideas: Idea[] }): FlowEntry[] {
  const out: FlowEntry[] = [];
  for (const run of v.runs ?? []) {
    if (run.status === "done" || run.status === "cancelled") continue;
    const p = runPosition(run);
    if (p) out.push({ kind: "run", key: `run-${run.number}`, number: run.number, url: run.url, goal: run.goal, pos: p, run });
  }
  for (const p of v.plans ?? []) out.push({ kind: "plan", key: `plan-${p.number}`, number: p.number, url: p.url, goal: p.goal, pos: planPosition(p) });
  for (const i of v.ideas ?? []) {
    if (i.closed || i.status === "done") continue;
    out.push({ kind: "idea", key: `idea-${i.number}`, number: i.number, url: i.url, goal: i.title, pos: ideaPosition(i) });
  }
  return out
    .map((e, i) => ({ e, i }))
    .sort((a, b) => b.e.pos.stage - a.e.pos.stage || subRank(b.e.pos) - subRank(a.e.pos) || a.i - b.i)
    .map((x) => x.e);
}

/** '다음 배포까지' text: min(pending, every)/every; null (hidden) when the pending count is unknown. */
export function deployProgressText(pending: number | null, every: number): string | null {
  return pending === null ? null : `${Math.min(pending, every)}/${every}`;
}
