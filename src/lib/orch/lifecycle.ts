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
  /** One-line summary shown on the stage-board row. */
  desc: string;
  sub: LifecycleSub[];
}

const subs = (n: number, titles: string[]): LifecycleSub[] => titles.map((title, i) => ({ id: `${n}.${i + 1}`, title }));

export const LIFECYCLE: readonly LifecycleStep[] = [
  { n: 1, title: "검토", desc: "아이디어를 PM·Codex가 평가하고 개발 여부를 정함", sub: subs(1, ["접수", "PM 분석", "Codex 평가", "의견 종합", "가치·우선순위", "개발 확정"]) },
  {
    n: 2, title: "계획", desc: "범위·단계·완료 조건을 짜고 감사 후 사용자 승인",
    sub: subs(2, ["코드 분석", "범위 정의", "단계 분할", "완료 조건", "모델·반영 정책", "계획 감사", "재감사", "사용자 승인", "개발 시작"]),
  },
  {
    n: 3, title: "개발", desc: "단계마다 구현 → 독립 검수 → CI → 반영",
    sub: subs(3, [
      "단계 확인", "AI 가용 확인", "모델 선택", "브랜치 준비", "코드 분석", "스킬 활용", "구현", "자체 검증",
      "PR 생성", "독립 검수", "CI", "종합 판정", "자동 수정", "재검수", "단계 반영", "다음 단계",
    ]),
  },
  { n: 4, title: "통합", desc: "최종 PR 통합 검사·충돌 처리 후 main 반영", sub: subs(4, ["완료 확인", "최종 PR", "통합 CI", "충돌 처리", "위험도 판단", "완공 보고서", "반영·승인", "완료·알림"]) },
  { n: 5, title: "배포", desc: "반영된 작업을 10개마다 Vercel에 배포", sub: subs(5, ["업데이트 집계", "배포 조건", "Vercel 배포", "상황판 갱신", "사용량 갱신", "PM 점검", "자동 복구", "결정 알림"]) },
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

export interface BoardItem {
  kind: "idea" | "plan" | "run";
  key: string;
  title: string;
  url: string;
  /** LIFECYCLE sub id, e.g. '3.10'. */
  sub: string;
  label: string;
  /** ISO time used for ordering (newest first); null sorts last. */
  at: string | null;
  run?: OrchRun;
  blocked?: boolean;
}

export type BoardStage = 1 | 2 | 3 | 4;
export type BoardTitle = "검토" | "계획" | "개발" | "통합";

export interface BoardColumn {
  n: BoardStage;
  title: BoardTitle;
  items: BoardItem[];
}

const BOARD_TITLES: readonly BoardTitle[] = ["검토", "계획", "개발", "통합"];

const atMs = (at: string | null) => {
  const t = Date.parse(at ?? "");
  return Number.isFinite(t) ? t : -Infinity;
};

/**
 * Stage board (4 columns: 1 검토 … 4 통합). Open ideas, plans waiting for audit / approval, active and blocked runs
 * sit in their lifecycle stage; done and cancelled runs are left out (finished work lives on the 패치노트 tab).
 * Each column is newest first.
 */
export function stageBoard(v: { runs: OrchRun[]; plans: PendingPlan[]; ideas: Idea[] }): BoardColumn[] {
  const cols: BoardColumn[] = BOARD_TITLES.map((title, i) => ({ n: (i + 1) as BoardStage, title, items: [] }));
  const put = (stage: LifecycleStage, item: BoardItem) => cols[stage - 1]?.items.push(item);
  for (const i of v.ideas ?? []) {
    if (!i || i.closed) continue;
    const p = ideaPosition(i);
    put(p.stage, { kind: "idea", key: `idea-${i.number}`, title: i.title, url: i.url, sub: p.sub, label: p.label, at: i.review?.at ?? i.createdAt ?? null });
  }
  for (const pl of v.plans ?? []) {
    if (!pl) continue;
    const p = planPosition(pl);
    put(p.stage, { kind: "plan", key: `plan-${pl.number}`, title: pl.goal, url: pl.url, sub: p.sub, label: p.label, at: pl.review?.at ?? null });
  }
  for (const run of v.runs ?? []) {
    if (!run || run.status === "cancelled" || run.status === "done") continue;
    const p = runPosition(run);
    if (!p) continue;
    put(p.stage, {
      kind: "run", key: `run-${run.number}`, title: run.goal, url: run.url, at: run.updatedAt ?? null, run,
      sub: p.sub, label: p.label, ...(run.status === "blocked" ? { blocked: true } : {}),
    });
  }
  for (const c of cols) {
    const ranked = c.items.map((item, i) => ({ item, i }));
    ranked.sort((a, b) => atMs(b.item.at) - atMs(a.item.at) || a.i - b.i);
    c.items = ranked.map((x) => x.item);
  }
  return cols;
}

/** Stages counted in '남은 과정' (5 배포 is left out). */
const COUNTED: readonly LifecycleStep[] = LIFECYCLE.filter((s) => s.n <= 4);

/** '전체 과정': 1 검토 6 + 2 계획 9 + 3 개발 16 + 4 통합 8 = 39. */
export const TOTAL_PROCESS = COUNTED.reduce((n, s) => n + s.sub.length, 0);

/** 'S.K' → [stage step, K] for stages 1~4 with 1 ≤ K ≤ sub count; otherwise null. */
function parseSub(sub: string): [LifecycleStep, number] | null {
  const m = /^(\d+)\.(\d+)$/.exec(String(sub ?? ""));
  if (!m) return null;
  const step = COUNTED.find((s) => s.n === Number(m[1]));
  const k = Number(m[2]);
  return step && k >= 1 && k <= step.sub.length ? [step, k] : null;
}

/** '단계 안 남은 과정' of a sub id: that stage's sub count − K (3.10 → 16−10 = 6). Stage 5 / bad id → null. */
export function stageRemaining(sub: string): number | null {
  const p = parseSub(sub);
  return p ? p[0].sub.length - p[1] : null;
}

/**
 * '전체 남은 과정'. Run / plan: the stage remainder + every later stage up to 4 (3.10 → 6 + 8 = 14).
 * Idea: development is not decided yet, so only the 1 검토 remainder counts. Bad id → null.
 */
export function totalRemaining(kind: BoardItem["kind"], sub: string): number | null {
  const p = parseSub(sub);
  if (!p) return null;
  const [step, k] = p;
  const here = step.sub.length - k;
  if (kind === "idea") return here;
  return here + COUNTED.filter((s) => s.n > step.n).reduce((n, s) => n + s.sub.length, 0);
}

export interface ItemProgress {
  total: number;
  done: number;
  remaining: number;
  stageRemaining: number;
  /** LIFECYCLE sub title at the current position, e.g. '독립 검수'. */
  title: string;
  /** One part per stage 1~4 (bar widths 6:9:16:8): how many of its subs are behind the item. */
  parts: { n: number; title: string; count: number; done: number }[];
  /** Stages still left, for '(개발 6 · 통합 8)'; zero parts left out. */
  left: { title: string; n: number }[];
}

/** Whole-flow progress of a run / plan at a sub id (the current sub counts as done). Bad id / stage 5 → null. */
export function itemProgress(sub: string): ItemProgress | null {
  const p = parseSub(sub);
  if (!p) return null;
  const [step, k] = p;
  const parts = COUNTED.map((s) => ({ n: s.n, title: s.title, count: s.sub.length, done: s.n < step.n ? s.sub.length : s.n === step.n ? k : 0 }));
  const remaining = totalRemaining("run", sub)!;
  return {
    total: TOTAL_PROCESS, done: TOTAL_PROCESS - remaining, remaining, stageRemaining: step.sub.length - k, title: step.sub[k - 1].title, parts,
    left: parts.map((x) => ({ title: x.title, n: x.count - x.done })).filter((x) => x.n > 0),
  };
}

/** Big number in a stage cell: the largest '단계 안 남은 과정' among its items; no items → null ('–'). */
export function columnRemaining(c: BoardColumn): number | null {
  const ns = c.items.map((i) => stageRemaining(i.sub)).filter((n): n is number => n !== null);
  return ns.length ? Math.max(...ns) : null;
}

/** '남은 할 일 N과정': sum of every board item's '전체 남은 과정'; no items → null ('남은 할 일 없음'). */
export function boardRemaining(cols: BoardColumn[]): number | null {
  const items = cols.flatMap((c) => c.items);
  if (!items.length) return null;
  return items.reduce((n, i) => n + (totalRemaining(i.kind, i.sub) ?? 0), 0);
}

/**
 * Items in a stage-board row that need the user (shown as '확인 필요 N' on the row line).
 * Rows all start collapsed: opening the 2·3·4 rows, or only rows needing the user, made the first project card
 * taller than 600px at 360x800.
 */
export function boardNeedsUser(c: BoardColumn): number {
  return c.items.filter((i) => !!i.run?.needsUser).length;
}
