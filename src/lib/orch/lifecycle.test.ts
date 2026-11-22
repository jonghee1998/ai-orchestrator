import assert from "node:assert/strict";
import test from "node:test";
import { LIFECYCLE, TOTAL_PROCESS, boardNeedsUser, boardRemaining, columnRemaining, flowEntries, ideaPosition, itemProgress, planPosition, runPosition, stageBoard, stageRemaining, totalRemaining, type BoardColumn, type BoardItem } from "./lifecycle";
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

test("flowEntries: active runs, plans and ideas under review, ordered 5→1", () => {
  const v = {
    runs: [
      run({ number: 1, status: "implementing", goal: "구현" }),
      run({ number: 2, status: "awaiting_merge", goal: "반영" }),
      run({ number: 3, status: "done", goal: "끝" }),
      run({ number: 4, status: "cancelled", goal: "취소" }),
      run({ number: 5, status: "reviewing", goal: "검수" }),
    ],
    plans: [plan(rv({ verdict: "OK" }))],
    ideas: [idea("collecting"), { ...idea("done"), number: 6 }, { ...idea("codex_pending"), number: 7, closed: true }],
  };
  const e = flowEntries(v);
  assert.deepEqual(e.map((x) => [x.kind, x.number, x.pos.sub]), [
    ["run", 2, "4.7"], ["run", 5, "3.10"], ["run", 1, "3.7"], ["plan", 2, "2.8"], ["idea", 3, "1.3"],
  ]);
  assert.equal(e[2].goal, "구현");
  assert.equal(e[4].goal, "t");
  assert.equal(e[0].kind === "run" && e[0].run.number, 2);
  assert.deepEqual(flowEntries({ runs: [], plans: [], ideas: [] }), []);
});

test("stageBoard: 4 columns, items placed by stage; done, cancelled and closed ideas left out", () => {
  const b = stageBoard({
    runs: [
      run({ number: 1, status: "implementing", goal: "구현", updatedAt: "2026-01-01T00:00:00Z" }),
      run({ number: 2, status: "awaiting_merge", goal: "반영" }),
      run({ number: 3, status: "done", goal: "끝", finalPr: 30 }),
      run({ number: 4, status: "cancelled", goal: "취소" }),
      run({ number: 5, status: "blocked", goal: "멈춤" }),
      run({ number: 6, status: "waiting", goal: "대기" }),
    ],
    plans: [plan(rv({ verdict: "OK" }))],
    ideas: [idea("collecting"), { ...idea("done"), number: 7 }, { ...idea("codex_pending"), number: 8, closed: true }],
  });
  assert.deepEqual(b.map((c) => [c.n, c.title]), [[1, "검토"], [2, "계획"], [3, "개발"], [4, "통합"]]);
  const keys = b.map((c) => c.items.map((i) => i.key).sort());
  assert.deepEqual(keys, [["idea-3", "idea-7"], ["plan-2", "run-6"], ["run-1", "run-5"], ["run-2"]]);
  const all = b.flatMap((c) => c.items);
  assert.ok(!all.some((i) => i.key === "run-3" || i.key === "run-4" || i.key === "idea-8"));
  const blocked = all.find((i) => i.key === "run-5")!;
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.sub, "3.12");
  const r1 = all.find((i) => i.key === "run-1")!;
  assert.equal(r1.blocked, undefined);
  assert.deepEqual([r1.kind, r1.title, r1.sub, r1.label, r1.at, r1.run?.number], ["run", "구현", "3.7", "구현 중 · Step 2/3", "2026-01-01T00:00:00Z", 1]);
  const p = all.find((i) => i.key === "plan-2")!;
  assert.deepEqual([p.kind, p.title, p.sub, p.label], ["plan", "g", "2.8", "승인 대기"]);
  const i3 = all.find((i) => i.key === "idea-3")!;
  assert.deepEqual([i3.kind, i3.title, i3.sub, i3.label], ["idea", "t", "1.3", "의견 수집 중"]);
  assert.deepEqual(stageBoard({ runs: [], plans: [], ideas: [] }).map((c) => c.items.length), [0, 0, 0, 0]);
});

test("stageBoard: columns newest first (null last)", () => {
  const b = stageBoard({
    runs: [
      run({ number: 1, status: "implementing", updatedAt: "2026-01-01T00:00:00Z" }),
      run({ number: 2, status: "reviewing", updatedAt: null }),
      run({ number: 3, status: "fixing", updatedAt: "2026-03-01T00:00:00Z" }),
    ],
    plans: [],
    ideas: [
      { ...idea("collecting"), number: 20, createdAt: "2026-01-01T00:00:00Z" },
      { ...idea("done"), number: 21, createdAt: "2026-01-01T00:00:00Z", review: { at: "2026-02-01T00:00:00Z" } as Idea["review"] },
    ],
  });
  assert.deepEqual(b[2].items.map((i) => i.key), ["run-3", "run-1", "run-2"]);
  assert.deepEqual(b[0].items.map((i) => i.key), ["idea-21", "idea-20"]);
});

const col = (n: 1 | 2 | 3 | 4, items: Partial<BoardItem>[]): BoardColumn => ({
  n, title: (["검토", "계획", "개발", "통합"] as const)[n - 1],
  items: items.map((x, i) => ({ kind: "run", key: `k${i}`, title: "t", url: "u", sub: "1.1", label: "", at: null, ...x })),
});

test("boardNeedsUser: counts run items that need the user", () => {
  assert.equal(boardNeedsUser(col(4, [])), 0);
  assert.equal(boardNeedsUser(col(3, [{}, { kind: "plan" }, { run: run({ needsUser: false }) }])), 0);
  assert.equal(boardNeedsUser(col(4, [{}, { run: run({ needsUser: true }) }, { run: run({ needsUser: true, number: 2 }) }])), 2);
});

test("stageRemaining: stage sub count − K + 1 (current sub not done yet); stage 5 / bad id → null", () => {
  assert.equal(stageRemaining("3.10"), 7);
  assert.equal(stageRemaining("1.3"), 4);
  assert.equal(stageRemaining("2.9"), 1);
  assert.equal(stageRemaining("4.8"), 1);
  assert.equal(stageRemaining("5.1"), null);
  assert.equal(stageRemaining("x"), null);
  assert.equal(stageRemaining("3.17"), null);
  assert.equal(stageRemaining("3.0"), null);
});

test("totalRemaining: run / plan = stage remainder + later stages up to 4; idea = stage 1 remainder only", () => {
  assert.equal(TOTAL_PROCESS, 39);
  assert.equal(totalRemaining("run", "3.10"), 15);
  assert.equal(TOTAL_PROCESS - totalRemaining("run", "3.10")!, 24);
  assert.equal(totalRemaining("plan", "2.8"), 2 + 16 + 8);
  assert.equal(totalRemaining("run", "4.7"), 2);
  assert.equal(totalRemaining("idea", "1.3"), 4);
  assert.equal(totalRemaining("run", "1.3"), 4 + 9 + 16 + 8);
  assert.equal(totalRemaining("run", "bad"), null);
});

test("itemProgress: 3.10 → 24 done, 15 left (개발 7 · 통합 8), bar fills 6/9/9/0 of 6/9/16/8", () => {
  const p = itemProgress("3.10")!;
  assert.deepEqual([p.total, p.done, p.remaining, p.stageRemaining, p.title], [39, 24, 15, 7, "독립 검수"]);
  assert.deepEqual(p.parts.map((x) => [x.n, x.title, x.count, x.done]), [[1, "검토", 6, 6], [2, "계획", 9, 9], [3, "개발", 16, 9], [4, "통합", 8, 0]]);
  assert.deepEqual(p.left, [{ title: "개발", n: 7 }, { title: "통합", n: 8 }]);
  // 2.9 시작 대기: 계획 마지막 1개가 아직 남음
  assert.deepEqual(itemProgress("2.9")!.left.map((x) => x.title), ["계획", "개발", "통합"]);
  assert.equal(itemProgress("5.2"), null);
});

test("columnRemaining: largest stage remainder in the column; no items → null", () => {
  assert.equal(columnRemaining(col(3, [])), null);
  assert.equal(columnRemaining(col(3, [{ sub: "3.10" }, { sub: "3.7" }])), 10);
  assert.equal(columnRemaining(col(1, [{ kind: "idea", sub: "1.3" }, { kind: "idea", sub: "1.5" }])), 4);
});

test("boardRemaining: sum of every item's total remainder; no items → null", () => {
  const b = stageBoard({ runs: [run({ number: 1, status: "reviewing" }), run({ number: 2, status: "awaiting_merge" })], plans: [plan(rv({ verdict: "OK" }))], ideas: [idea("collecting")] });
  assert.equal(boardRemaining(b), 15 + 2 + 26 + 4);
  assert.equal(boardRemaining(stageBoard({ runs: [run({ status: "done" })], plans: [], ideas: [] })), null);
});
