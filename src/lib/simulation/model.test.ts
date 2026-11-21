import test from "node:test";
import assert from "node:assert/strict";
import { agentAvailable, initialSimulation, recalculateRestrictions, remaining } from "./model";

test("development fixture has three projects and shared Claude quota", () => {
  const state = initialSimulation(Date.parse("2026-01-01T00:00:00Z"));
  assert.equal(state.projects.length, 3);
  assert.equal(state.usage.find((u) => u.id === "claude")?.periods[0].used, 40);
  assert.equal(state.agents.filter((a) => a.id === "sonnet" || a.id === "opus").length, 2);
});

test("shared Claude limit restricts both models but preserves manual off", () => {
  const state = initialSimulation();
  state.agents.find((a) => a.id === "sonnet")!.manualEnabled = true;
  state.usage.find((u) => u.id === "claude")!.periods[0].used = 95;
  const limited = recalculateRestrictions(state);
  assert.equal(agentAvailable(limited, "sonnet"), false);
  assert.equal(limited.agents.find((a) => a.id === "opus")?.manualEnabled, false);
  limited.usage.find((u) => u.id === "claude")!.periods[0].used = 0;
  const reset = recalculateRestrictions(limited);
  assert.equal(agentAvailable(reset, "sonnet"), true);
  assert.equal(agentAvailable(reset, "opus"), false);
});

test("countdown is calculated from reset timestamp", () => {
  assert.equal(remaining("2026-01-01T03:00:00Z", Date.parse("2026-01-01T00:00:00Z")), "3시간 뒤 초기화");
  assert.equal(remaining(null), "확인 불가");
});

import { applyDecision, enforceAlwaysOn, isManageable, toggleAgentState } from "./model";

test("GPT PM cannot be toggled OFF and persisted OFF is repaired", () => {
  const s = initialSimulation();
  assert.equal(isManageable("gpt"), false);
  assert.equal(toggleAgentState(s, "gpt").agents.find((a) => a.id === "gpt")?.manualEnabled, true);
  assert.equal(toggleAgentState(s, "codex").agents.find((a) => a.id === "codex")?.manualEnabled, false);
  const off = { ...s, agents: s.agents.map((a) => a.id === "gpt" ? { ...a, manualEnabled: false } : a) };
  assert.equal(enforceAlwaysOn(off).agents.find((a) => a.id === "gpt")?.manualEnabled, true);
});

function twoPending() {
  const s = initialSimulation();
  const p = s.projects[0];
  p.tasks.push({ id: "t9", title: "두번째 승인", stageId: "o3", agent: "gpt", state: "decision", criterion: "x" });
  s.briefings.unshift({ id: "b9", type: "decision", projectId: p.id, taskId: "t9", title: "두번째", summary: "s", at: "", next: "", owner: "사용자", decision: "pending" });
  return s;
}
const task = (s: ReturnType<typeof initialSimulation>, id: string) => s.projects[0].tasks.find((t) => t.id === id)!;

test("decide affects only the selected task with multiple pending tasks in one project", () => {
  const next = applyDecision(twoPending(), "b9", "approved");
  assert.equal(task(next, "t9").state, "done");
  assert.equal(task(next, "t2").state, "decision");
  assert.equal(next.briefings.find((b) => b.id === "b1")?.decision, "pending");
  assert.equal(next.briefings.find((b) => b.id === "b9")?.decision, "approved");
  const held = applyDecision(twoPending(), "b1", "held");
  assert.equal(task(held, "t2").state, "paused");
  assert.equal(task(held, "t9").state, "decision");
});

test("decide prevents duplicate decisions and recomputes stage/project state", () => {
  const once = applyDecision(twoPending(), "b9", "approved");
  const twice = applyDecision(once, "b9", "held");
  assert.equal(task(twice, "t9").state, "done");
  assert.equal(twice, once);
  assert.equal(applyDecision(once, "missing", "approved"), once);
  // stage o3 becomes done only when every task in it is done
  const s = twoPending();
  s.projects[0].tasks.find((t) => t.id === "t1")!.state = "done";
  const a = applyDecision(s, "b9", "approved");
  assert.equal(a.projects[0].stages.find((x) => x.id === "o3")?.status, "active");
  const b = applyDecision(a, "b1", "approved");
  assert.equal(b.projects[0].stages.find((x) => x.id === "o3")?.status, "done");
  assert.equal(b.projects[0].state, "active");
});
