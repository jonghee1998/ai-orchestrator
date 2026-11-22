import assert from "node:assert/strict";
import test from "node:test";
import { LIFECYCLE, boardDeployCounts, boardNeedsUser, deployProgressText, flowEntries, ideaPosition, planPosition, runPosition, stageBoard, type BoardColumn, type BoardItem } from "./lifecycle";
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

test("deployProgressText: min(pending, every)/every, hidden when unknown", () => {
  assert.equal(deployProgressText(3, 10), "3/10");
  assert.equal(deployProgressText(14, 10), "10/10");
  assert.equal(deployProgressText(0, 5), "0/5");
  assert.equal(deployProgressText(null, 10), null);
});

test("stageBoard: 5 columns, items placed by stage; done → 5 완료, cancelled and closed ideas left out", () => {
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
    pendingPrs: [],
  });
  assert.deepEqual(b.map((c) => [c.n, c.title]), [[1, "검토"], [2, "계획"], [3, "개발"], [4, "통합"], [5, "완료"]]);
  const keys = b.map((c) => c.items.map((i) => i.key).sort());
  assert.deepEqual(keys, [["idea-3", "idea-7"], ["plan-2", "run-6"], ["run-1", "run-5"], ["run-2"], ["run-3"]]);
  const all = b.flatMap((c) => c.items);
  assert.ok(!all.some((i) => i.key === "run-4" || i.key === "idea-8"));
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
  const done = b[4].items[0];
  assert.deepEqual([done.label, done.deployed, done.run?.number], ["완료", true, 3]);
  assert.deepEqual(stageBoard({ runs: [], plans: [], ideas: [], pendingPrs: null }).map((c) => c.items.length), [0, 0, 0, 0, 0]);
});

test("stageBoard: done run deploy state from pendingPrs (no time comparison)", () => {
  const done = (number: number, finalPr: number | null) => run({ number, status: "done", finalPr, updatedAt: "2099-01-01T00:00:00Z" });
  const runs = [done(1, 10), done(2, 20), done(3, null)];
  const state = (pendingPrs: number[] | null) =>
    Object.fromEntries(stageBoard({ runs, plans: [], ideas: [], pendingPrs })[4].items.map((i) => [i.key, i.deployed]));
  assert.deepEqual(state([10]), { "run-1": false, "run-2": true, "run-3": null });
  assert.deepEqual(state([]), { "run-1": true, "run-2": true, "run-3": null });
  assert.deepEqual(state(null), { "run-1": null, "run-2": null, "run-3": null });
});

test("stageBoard: columns newest first (null last); column 5 orders 배포 대기 → 배포됨 → 알 수 없음", () => {
  const b = stageBoard({
    runs: [
      run({ number: 1, status: "implementing", updatedAt: "2026-01-01T00:00:00Z" }),
      run({ number: 2, status: "reviewing", updatedAt: null }),
      run({ number: 3, status: "fixing", updatedAt: "2026-03-01T00:00:00Z" }),
      run({ number: 10, status: "done", finalPr: 100, updatedAt: "2026-05-01T00:00:00Z" }), // deployed, newer
      run({ number: 11, status: "done", finalPr: 110, updatedAt: "2026-01-01T00:00:00Z" }), // pending, older
      run({ number: 12, status: "done", finalPr: null, updatedAt: "2026-06-01T00:00:00Z" }), // unknown, newest
      run({ number: 13, status: "done", finalPr: 130, updatedAt: "2026-02-01T00:00:00Z" }), // pending, newer
      run({ number: 14, status: "done", finalPr: 140, updatedAt: "2026-04-01T00:00:00Z" }), // deployed, older
    ],
    plans: [],
    ideas: [
      { ...idea("collecting"), number: 20, createdAt: "2026-01-01T00:00:00Z" },
      { ...idea("done"), number: 21, createdAt: "2026-01-01T00:00:00Z", review: { at: "2026-02-01T00:00:00Z" } as Idea["review"] },
    ],
    pendingPrs: [110, 130],
  });
  assert.deepEqual(b[2].items.map((i) => i.key), ["run-3", "run-1", "run-2"]);
  assert.deepEqual(b[0].items.map((i) => i.key), ["idea-21", "idea-20"]);
  assert.deepEqual(b[4].items.map((i) => [i.key, i.deployed]), [
    ["run-13", false], ["run-11", false], ["run-10", true], ["run-14", true], ["run-12", null],
  ]);
});

const col = (n: 1 | 2 | 3 | 4 | 5, items: Partial<BoardItem>[]): BoardColumn => ({
  n, title: (["검토", "계획", "개발", "통합", "완료"] as const)[n - 1],
  items: items.map((x, i) => ({ kind: "run", key: `k${i}`, title: "t", url: "u", sub: "1.1", label: "", at: null, ...x })),
});

test("boardNeedsUser: counts run items that need the user", () => {
  assert.equal(boardNeedsUser(col(4, [])), 0);
  assert.equal(boardNeedsUser(col(3, [{}, { kind: "plan" }, { run: run({ needsUser: false }) }])), 0);
  assert.equal(boardNeedsUser(col(4, [{}, { run: run({ needsUser: true }) }, { run: run({ needsUser: true, number: 2 }) }])), 2);
});

test("boardDeployCounts: 배포 대기 / 배포됨, unknown counted in neither", () => {
  assert.deepEqual(boardDeployCounts(col(5, [{ deployed: false }, { deployed: true }, { deployed: true }, { deployed: null }, {}])), { pending: 1, deployed: 2 });
  assert.deepEqual(boardDeployCounts(col(5, [])), { pending: 0, deployed: 0 });
});
