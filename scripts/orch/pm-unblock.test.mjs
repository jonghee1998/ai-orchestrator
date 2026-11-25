import test from "node:test";
import assert from "node:assert/strict";
import * as C from "./core.mjs";
import { decideUnblock, applyDecision, unblockPrompt, RESUME_MARK } from "./pm-unblock.mjs";

const plan = { goal: "g", steps: [{ id: 1, title: "t1", task: "k1", done_when: ["d"] }, { id: 2, title: "t2", task: "k2", done_when: ["d"] }] };
const body = (st) => "계획\n\n```json\n" + JSON.stringify(plan) + "\n```\n" + C.stateMarker({ v: 1, ...st });

test("decideUnblock: only blocked runs in auto mode, not final, not twice for the same stop, max 3 auto resumes", () => {
  const issue = { body: body({ status: "blocked", step: 1, reason: "r", updatedAt: "T1" }) };
  assert.equal(decideUnblock({ issue, comments: [], auto: false, codex: true }).skip, true);
  assert.equal(decideUnblock({ issue, comments: [], auto: true, codex: false }).skip, true);
  assert.equal(decideUnblock({ issue, comments: [], auto: true, codex: true }).skip, false);
  assert.equal(decideUnblock({ issue: { body: body({ status: "implementing", step: 1 }) }, comments: [], auto: true, codex: true }).skip, true);
  assert.equal(decideUnblock({ issue: { body: body({ status: "blocked", blockKind: "final", step: 1 }) }, comments: [], auto: true, codex: true }).skip, true);
  assert.equal(decideUnblock({ issue, comments: [{ body: "x <!-- pm-unblock:T1 -->" }], auto: true, codex: true }).skip, true);
  const three = Array.from({ length: 3 }, () => ({ body: RESUME_MARK + "\n### 🤖 Codex PM 자동 재개" }));
  assert.equal(decideUnblock({ issue, comments: three, auto: true, codex: true }).skip, true);
  assert.equal(decideUnblock({ issue, comments: [{ body: RESUME_MARK + "\n사람 재개" }], auto: true, codex: true }).skip, false);
});

test("applyDecision: appends [PM 지시] to existing steps only; human passes through; bad input rejected", () => {
  const r = applyDecision(plan, JSON.stringify({ action: "resume", cause: "c", notes: [{ step: 1, text: "옛 클래스 유지" }, { step: 9, text: "x" }] }));
  assert.equal(r.ok, true);
  assert.equal(r.applied, 1);
  assert.match(r.plan.steps[0].task, /k1 \[PM 지시\] 옛 클래스 유지$/);
  assert.equal(plan.steps[0].task, "k1", "input not mutated");
  assert.equal(applyDecision(plan, JSON.stringify({ action: "human", cause: "파일 필요" })).action, "human");
  assert.equal(applyDecision(plan, JSON.stringify({ action: "resume", notes: [] })).ok, false);
  assert.equal(applyDecision(plan, "nope").ok, false);
  // parsePlan이 채운 model: null(지정 없음)은 형식 오류가 아니다 (#379에서 자동 해제가 막힌 원인)
  const withNull = { ...plan, model: null, steps: plan.steps.map((s) => ({ ...s, model: null })) };
  assert.equal(applyDecision(withNull, JSON.stringify({ action: "resume", cause: "c", notes: [{ step: 1, text: "x" }] })).ok, true);
  assert.match(unblockPrompt({ repo: "o/r", plan, state: { step: 1, reason: "r" }, logs: "", review: "" }), /PM_DECISION\.json/);
});
