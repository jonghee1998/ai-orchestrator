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
