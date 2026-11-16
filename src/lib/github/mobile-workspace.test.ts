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
  // P1-a (#98): previously a closed issue alone mapped to "done". Closed without a declared completion type is now
  // "종료됨 · 완료유형 미확인" (phase unknown); it is done only with type-specific evidence (see lifecycle.test.ts).
  const closed = workspace([{ ...tasks[0], issueState: "closed" }]).tasks[0];
  assert.equal(closed.phase, "unknown");
  assert.equal(closed.lifecycle.phase, "closed_unverified");
  assert.equal(workspace([{ ...tasks[0], issueState: "closed", description: "완료유형: nondeploy\n완료 조건: 보고서 제출" }], { ...demoEvidence("normal"), issues: [{ ...demoEvidence("normal").issues[0], number: 903, state: "closed", completions: demoEvidence("normal").issues[2].completions }] }).tasks[0].phase, "done");
  assert.equal(workspace([{ ...tasks[0], status: "unknown" }]).tasks[0].phase, "unknown");
});
test("sample goals, task identity and counts are shared across screens; dependencies fail closed", () => {
  const model = workspace(demoQueue("normal"), demoEvidence("normal"));
  assert.equal(model.projects.length, 3);
  for (const p of model.projects) {
    assert.ok(p.goal); assert.equal(p.done + p.remaining, p.tasks.length);
    assert.equal(p.active, p.tasks.filter(t => ["active", "review"].includes(t.phase)).length);
  }
  // P1-a (#98): sample-report tasks are closed but declare no completion type/criteria → not "업무 완료" (was expected before).
  assert.notEqual(model.projects.find(p => p.id === "sample-report")?.stage, "업무 완료");
  assert.equal(model.projects.find(p => p.id === "sample-report")?.done, 0);
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
