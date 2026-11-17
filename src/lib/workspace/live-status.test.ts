import assert from "node:assert/strict";
import test from "node:test";
import { liveStatus, latestVerdict } from "./live-status";
import type { ModelProject, ModelTask } from "./model";

const task = (id: string, phase: string): ModelTask => ({ id, title: `t${id}`, url: "", agent: "sonnet", agentName: "Claude Sonnet", phase, phaseLabel: phase, completion: "incomplete", completionLabel: "", complete: false, selfReportedOnly: false, next: "", waiting: "", missing: [] });
const project = (tasks: ModelTask[], history: ModelProject["history"] = [], goal?: string): ModelProject => ({ id: "p", name: "P", goal, stage: "s",
  counts: { total: tasks.length, completed: tasks.filter(t => t.phase === "done").length, remaining: tasks.filter(t => t.phase === "remaining").length, active: tasks.filter(t => t.phase === "active").length, reported: 0, unknown: tasks.filter(t => t.phase === "unknown").length, completedWithoutOfficialReview: 0 },
  tasks, completed: [], remaining: [], history });
const ev = (at: string, change: string) => ({ id: at, at, taskId: "1", actor: "a", change, source: "GitHub 자기보고" });

test("live status: goal unknown stays unknown; no percentages", () => {
  const s = liveStatus(project([task("1", "active"), task("2", "remaining")]));
  assert.equal(s.goal, "목표 미확인");
  assert.deepEqual(s.current.map(c => [c.id, c.agentName, c.stage]), [["1", "Claude Sonnet", "active"]]);
  assert.ok(!/%/.test(s.summary));
  assert.equal(liveStatus(project([], [], "실제 목표")).goal, "실제 목표");
  assert.equal(liveStatus(project([])).summary, "확인된 업무가 없습니다.");
});
test("live status verdicts: blocked > approval-needed > newest history; pass is self-reported only", () => {
  assert.equal(latestVerdict(project([task("1", "blocked"), task("2", "review")])), "blocked");
  assert.equal(latestVerdict(project([task("1", "review")])), "approval_needed");
  assert.equal(latestVerdict(project([task("1", "active")], [ev("2026-01-01", "검수 통과 보고 · 배포 여부는 별도 확인"), ev("2026-01-02", "수정 요청")])), "fail");
  const pass = liveStatus(project([task("1", "active")], [ev("2026-01-03", "검수 통과 보고 · 배포 여부는 별도 확인")]));
  assert.equal(pass.verdict, "pass");
  assert.match(pass.verdictLabel, /자기보고/);
  assert.equal(latestVerdict(project([task("1", "active")])), "none");
});
