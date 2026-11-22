import assert from "node:assert/strict";
import test from "node:test";
import { LIFECYCLE, ideaPosition, planPosition, runPosition } from "./lifecycle";
import type { Idea, OrchRun, PendingPlan, RunStep } from "./model";

const EXPECTED: Record<number, [string, string[]]> = {
  1: ["검토", ["접수", "PM 분석", "Codex 평가", "의견 종합", "가치·우선순위", "개발 확정"]],
  2: ["계획", ["코드 분석", "범위 정의", "단계 분할", "완료 조건", "모델·반영 정책", "계획 감사", "재감사", "사용자 승인", "개발 시작"]],
  3: ["개발", ["단계 확인", "AI 가용 확인", "모델 선택", "브랜치 준비", "코드 분석", "스킬 활용", "구현", "자체 검증", "PR 생성", "독립 검수", "CI", "종합 판정", "자동 수정", "재검수", "단계 반영", "다음 단계"]],
  4: ["통합", ["완료 확인", "최종 PR", "통합 CI", "충돌 처리", "위험도 판단", "완공 보고서", "반영·승인", "완료·알림"]],
  5: ["배포", ["업데이트 집계", "배포 조건", "Vercel 배포", "상황판 갱신", "사용량 갱신", "PM 점검", "자동 복구", "결정 알림"]],
};

test("LIFECYCLE: 5 stages, sub counts 6/9/16/8/8, ids and titles match the task list", () => {
  assert.deepEqual(LIFECYCLE.map((s) => s.n), [1, 2, 3, 4, 5]);
  assert.deepEqual(LIFECYCLE.map((s) => s.sub.length), [6, 9, 16, 8, 8]);
  for (const s of LIFECYCLE) {
    const [title, subs] = EXPECTED[s.n];
    assert.equal(s.title, title);
    assert.deepEqual(s.sub, subs.map((t, i) => ({ id: `${s.n}.${i + 1}`, title: t })));
  }
  assert.equal(LIFECYCLE[2].sub[9].id, "3.10");
  assert.equal(LIFECYCLE[2].sub[9].title, "독립 검수");
});

const steps = (...states: RunStep["state"][]): RunStep[] => states.map((state, i) => ({ id: i + 1, title: `s${i + 1}`, state, checks: [] }));

function run(over: Partial<OrchRun>): OrchRun {
  return {
    steps: steps("passed", "current", "pending"), repo: "o/r", number: 1, url: "u", goal: "g", status: "waiting", statusLabel: "",
    step: 2, total: 3, passed: 1, pr: null, finalPr: null, retries: 0, maxRetries: 3, held: null, reason: null, updatedAt: null,
    needsUser: false, next: "", ...over,
  };
}

test("runPosition: status mapping", () => {
  assert.deepEqual(runPosition(run({ status: "waiting", step: null })), { stage: 2, sub: "2.9", label: "시작 대기" });
  assert.deepEqual(runPosition(run({ status: "waiting", held: "OFF" })), { stage: 2, sub: "2.9", label: "ON/OFF 대기" });
  assert.deepEqual(runPosition(run({ status: "implementing" })), { stage: 3, sub: "3.7", label: "구현 중 · Step 2/3" });
  assert.deepEqual(runPosition(run({ status: "reviewing" })), { stage: 3, sub: "3.10", label: "검수 중 · Step 2/3" });
  assert.deepEqual(runPosition(run({ status: "fixing", retries: 1, maxRetries: 3 })), { stage: 3, sub: "3.13", label: "자동 수정 중 · Step 2/3 · 수정 1/3" });
  assert.deepEqual(runPosition(run({ status: "finalizing" })), { stage: 4, sub: "4.3", label: "통합 검사 중" });
  assert.deepEqual(runPosition(run({ status: "awaiting_merge" })), { stage: 4, sub: "4.7", label: "반영 승인 대기" });
  assert.deepEqual(runPosition(run({ status: "done" })), { stage: 4, sub: "4.8", label: "완료" });
  assert.equal(runPosition(run({ status: "cancelled" })), null);
});

test("runPosition: blocked is guessed from steps", () => {
  assert.deepEqual(runPosition(run({ status: "blocked", steps: steps("passed", "passed", "passed"), step: 3 })), { stage: 4, sub: "4.4", label: "멈춤(통합)" });
  assert.deepEqual(runPosition(run({ status: "blocked", steps: steps("passed", "current", "pending") })), { stage: 3, sub: "3.12", label: "멈춤(Step 2) · Step 2/3" });
  // No step in state → first not-passed step.
  assert.deepEqual(runPosition(run({ status: "blocked", step: null, steps: steps("passed", "pending", "pending") })), { stage: 3, sub: "3.12", label: "멈춤(Step 2) · Step 2/3" });
  assert.deepEqual(runPosition(run({ status: "blocked", step: null, steps: [], total: 0 })), { stage: 3, sub: "3.12", label: "멈춤" });
});

test("runPosition: unknown status does not throw", () => {
  assert.deepEqual(runPosition(run({ status: "weird" as OrchRun["status"] })), { stage: 2, sub: "2.9", label: "시작 대기" });
});

function plan(review: PendingPlan["review"]): PendingPlan {
  return { repo: "o/r", number: 2, url: "u", goal: "g", steps: 3, hash: "h", review };
}
const rv = (over: Partial<NonNullable<PendingPlan["review"]>>) => ({ round: 1, verdict: "OK" as const, reviewer: "codex", at: null, hash: "h", stale: false, ...over });

test("planPosition: audit state mapping", () => {
  assert.deepEqual(planPosition(plan(null)), { stage: 2, sub: "2.6", label: "감사 대기" });
  assert.deepEqual(planPosition(plan(rv({ verdict: "REVISE", round: 2 }))), { stage: 2, sub: "2.7", label: "수정 필요 2/3" });
  assert.deepEqual(planPosition(plan(rv({ verdict: "OK" }))), { stage: 2, sub: "2.8", label: "승인 대기" });
  assert.deepEqual(planPosition(plan(rv({ verdict: "ERROR" }))), { stage: 2, sub: "2.6", label: "재감사 대기" });
  assert.deepEqual(planPosition(plan(rv({ verdict: "OK", stale: true }))), { stage: 2, sub: "2.6", label: "재감사 대기" });
  assert.deepEqual(planPosition(plan(rv({ verdict: "REVISE", stale: true }))), { stage: 2, sub: "2.6", label: "재감사 대기" });
  assert.doesNotThrow(() => planPosition(plan(rv({ verdict: "??" as "OK" }))));
});

function idea(status: Idea["status"]): Idea {
  return { repo: "o/r", number: 3, url: "u", title: "t", mine: "", createdAt: null, closed: false, status, review: null };
}

test("ideaPosition: status mapping", () => {
  assert.equal(ideaPosition(idea("collecting")).sub, "1.3");
  assert.equal(ideaPosition(idea("collecting")).stage, 1);
  assert.deepEqual(ideaPosition(idea("codex_pending")), { stage: 1, sub: "1.3", label: "Codex 대기" });
  assert.deepEqual(ideaPosition(idea("done")), { stage: 1, sub: "1.5", label: "의견 완료" });
  assert.equal(ideaPosition(idea("stale")).sub, "1.2");
  assert.equal(ideaPosition(idea("weird" as Idea["status"])).sub, "1.2");
});
