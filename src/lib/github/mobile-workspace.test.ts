import assert from "node:assert/strict";
import test from "node:test";
import { workspace, workActivity, PHASE_LABEL, type Runtime } from "./mobile-workspace";
import { normalizeIssues, type WorkQueueTask } from "./work-queue";
import { demoQueue, demoEvidence, demoDashboard } from "../demo/fixtures";

test("projects use one unambiguous label or milestone; no fabricated project/goal", () => {
  const base = { number: 1, title: "task", body: null, labels: [], html_url: "" };
  const rows = normalizeIssues([
    { ...base, labels: ["project:real"] },
    { ...base, number: 2, milestone: { number: 7, title: "Release", description: "Actual goal" } },
    { ...base, number: 3, labels: ["project:a", "project:b"] },
    { ...base, number: 4 },
  ]);
  const model = workspace(rows);
  assert.deepEqual(model.projects.map(p => p.name), ["real", "Release", "미분류"]);
  assert.equal(model.projects[0].goal, undefined);
  assert.equal(model.projects[1].goal, "Actual goal");
  assert.equal(model.projects[2].tasks.length, 2);
});
test("completion requires closed issue/merged result, not status label or completion self-report", () => {
  const tasks: WorkQueueTask[] = [{ id: "903", title: "review", status: "done", agent: "opus", url: "", dependsOn: [] }];
  assert.equal(workspace(tasks, demoEvidence("normal")).tasks[0].phase, "review");
  // Changed (Issue #99): a closed issue with no explicit completion type is no longer "done"; unknown never final-completes.
  assert.equal(workspace([{ ...tasks[0], issueState: "closed" }]).tasks[0].phase, "unknown");
  // Changed (Issue #102): closing alone is not acceptance; it must be closed as completed.
  assert.notEqual(workspace([{ ...tasks[0], issueState: "closed", description: "Completion type: nondeploy" }]).tasks[0].phase, "done");
  assert.equal(workspace([{ ...tasks[0], issueState: "closed", stateReason: "completed", description: "Completion type: nondeploy" }]).tasks[0].phase, "done");
  assert.equal(workspace([{ ...tasks[0], status: "unknown" }]).tasks[0].phase, "unknown");
});
test("sample goals, task identity and counts are shared across screens; dependencies fail closed", () => {
  const model = workspace(demoQueue("normal"), demoEvidence("normal"));
  assert.equal(model.projects.length, 3);
  for (const p of model.projects) {
    assert.ok(p.goal); assert.equal(p.done + p.remaining, p.tasks.length);
    assert.equal(p.active, p.tasks.filter(t => ["active", "review"].includes(t.phase)).length);
  }
  assert.equal(model.projects.find(p => p.id === "sample-report")?.stage, "업무 완료");
  assert.equal(model.tasks.find(t => t.id === "904")?.phase, "blocked");
  assert.match(model.tasks.find(t => t.id === "906")!.waiting, /#999/);
  for (const t of model.tasks) {
    if (t.proof) { assert.equal(t.title, t.proof.title); assert.equal(t.agent, t.proof.agent); }
    assert.ok(PHASE_LABEL[t.phase]);
  }
  assert.equal(workspace(demoQueue("empty")).projects.length, 0);
});
test("activities retain source, de-duplicate repeated evidence, and never upgrade self-reports to deployment", () => {
  const e = demoEvidence("normal");
  e.issues[1].acks.push(e.issues[1].acks[0]);
  const model = workspace(demoQueue("normal"), e);
  const runtime = demoDashboard("normal") as unknown as Runtime;
  const events = workActivity(model.tasks, e, runtime);
  assert.equal(events.length, new Set(events.map(e => e.id)).size);
  assert.ok(events.some(e => e.source === "GitHub 자기보고"));
  assert.ok(events.some(e => e.source === "내부 실행 기록"));
  assert.ok(events.some(e => e.change === "설정 변경"));
  assert.ok(events.every(e => e.change !== "배포 완료"));
  assert.deepEqual(events.map(e => e.at), events.map(e => e.at).sort().reverse());
  for (const event of events.filter(e => e.title !== "배정 설정")) assert.ok(model.tasks.some(t => t.title === event.title));
});
