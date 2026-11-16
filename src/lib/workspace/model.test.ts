import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkspaceModel, type ModelInput } from "./model";
import type { Live } from "../refresh/live-loader";
import type { WorkQueueTask } from "../github/work-queue";
import type { EvidenceReport } from "../github/evidence-types";
import type { Runtime } from "../github/mobile-workspace";
import { demoQueue, demoEvidence, demoDashboard } from "../demo/fixtures";

const ok = <T,>(data: T): Live<T> => ({ kind: "ok", data });
const full = (): ModelInput => ({ queue: ok(demoQueue("normal")), evidence: ok(demoEvidence("normal")), runtime: ok(demoDashboard("normal") as unknown as Runtime) });
const none: Live<never> = { kind: "unconfigured" };

test("live: all three sources ok → live model with projects, assignments, briefing", () => {
  const m = buildWorkspaceModel(full());
  assert.equal(m.version, 1); assert.equal(m.source, "live"); assert.deepEqual(m.missingParts, []);
  assert.ok(m.projects.length > 0);
  for (const p of m.projects) { assert.equal(p.counts.completed + p.counts.remaining, p.counts.total); assert.equal(p.completed.length + p.remaining.length, p.tasks.length); }
  assert.deepEqual(m.agents.map(a => a.key), ["gpt", "codex", "sonnet", "opus"]);
  assert.ok(m.agents.some(a => a.assignments.length > 0));
  assert.ok(m.briefing.next.length + m.briefing.decisions.length + m.briefing.incidents.length > 0);
});
test("unconnected: queue unavailable → no projects/tasks/briefing invented, for every failure kind", () => {
  for (const q of [none, { kind: "notoken" }, { kind: "unauth" }, { kind: "error", detail: "x" }] as Live<WorkQueueTask[]>[]) {
    const m = buildWorkspaceModel({ ...full(), queue: q });
    assert.equal(m.source, "unconnected"); assert.equal(m.projects.length, 0);
    assert.equal(m.briefing.decisions.length + m.briefing.approvals.length + m.briefing.next.length, 0);
    assert.ok(m.missingParts.includes("queue")); assert.ok(m.notes.length > 0);
  }
  assert.equal(buildWorkspaceModel({ queue: { kind: "loading" }, evidence: { kind: "loading" }, runtime: { kind: "loading" } }).source, "loading");
});
test("partial: missing evidence/runtime is explicit, never upgraded to completion, usage and running stay unknown", () => {
  const e = buildWorkspaceModel({ ...full(), evidence: none as Live<EvidenceReport> });
  assert.equal(e.source, "partial"); assert.deepEqual(e.missingParts, ["evidence"]);
  assert.ok(e.notes.some(n => n.includes("GitHub 증거")));
  const ids = (m: ReturnType<typeof buildWorkspaceModel>) => m.projects.flatMap(p => p.completed.map(t => t.id));
  const withEvidence = new Set(ids(buildWorkspaceModel(full())));
  assert.ok(ids(e).every(id => withEvidence.has(id)), "losing evidence may never create a completion");
  assert.ok(e.projects.flatMap(p => p.tasks).filter(t => !t.complete && t.phase !== "remaining").every(t => t.completion !== "complete"));
  const r = buildWorkspaceModel({ ...full(), runtime: { kind: "error", detail: "x" } });
  assert.equal(r.source, "partial");
  for (const a of r.agents) { assert.equal(a.recordedRuns, "unknown"); assert.equal(a.usage.state, "unknown"); assert.equal(a.execution, "unverified"); if (a.key !== "gpt") assert.equal(a.control.enabled, "unknown"); }
});
test("partial: truncated collection is surfaced even when all sources respond", () => {
  const ev = demoEvidence("normal"); ev.limits.issuesTruncated = true;
  const m = buildWorkspaceModel({ ...full(), evidence: ok(ev) });
  assert.equal(m.source, "partial"); assert.ok(m.notes.some(n => n.includes("잘려")));
});
test("no false completion: open/closed-without-type/status-label done never complete; unknown goal stays unknown", () => {
  const base: WorkQueueTask = { id: "1", title: "t", status: "done", agent: "claude", url: "", dependsOn: [] };
  const run = (t: WorkQueueTask) => buildWorkspaceModel({ queue: ok([t]), evidence: ok({ ...demoEvidence("empty"), issues: [] }), runtime: ok(demoDashboard("empty") as unknown as Runtime) });
  for (const t of [base, { ...base, issueState: "closed" as const }, { ...base, issueState: "closed" as const, description: "Completion type: nondeploy" }]) {
    const m = run(t); assert.equal(m.projects[0].counts.completed, 0); assert.equal(m.projects[0].tasks[0].complete, false);
  }
  const m = run(base); assert.equal(m.projects[0].goal, undefined); assert.equal(m.projects[0].id, "unclassified");
  assert.equal(run({ ...base, issueState: "closed", stateReason: "completed", description: "Completion type: nondeploy" }).projects[0].counts.completed, 1);
});
test("agents: GPT always on; other controls read-only; usage never fabricated", () => {
  const m = buildWorkspaceModel(full());
  const gpt = m.agents.find(a => a.key === "gpt")!;
  assert.equal(gpt.control.alwaysOn, true); assert.equal(gpt.control.enabled, true);
  for (const a of m.agents) { assert.equal(a.control.editable, false); assert.deepEqual(a.usage, { state: "unknown" }); assert.equal(a.execution, "unverified"); }
  const unconnected = buildWorkspaceModel({ ...full(), queue: none });
  assert.equal(unconnected.agents.find(a => a.key === "gpt")!.control.enabled, true);
  assert.ok(unconnected.agents.filter(a => a.key !== "gpt").every(a => a.control.enabled === (unconnected.parts.runtime === "ok" ? a.control.enabled : "unknown")));
});
test("self-reported PM acceptance is labelled, not an official approval", () => {
  const m = buildWorkspaceModel(full());
  for (const a of m.briefing.approvals) assert.ok(a.detail.includes("공식 GitHub 승인") || a.detail.includes("자기보고"));
  assert.ok(m.briefing.incidents.every(i => i.title && i.evidence));
});
test("model is pure: same input → same output, input not mutated", () => {
  const input = full(); const before = JSON.stringify(input);
  assert.deepEqual(buildWorkspaceModel(input), buildWorkspaceModel(input)); assert.equal(JSON.stringify(input), before);
});
