import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkspaceModel, type ModelInput } from "./model";
import type { Live } from "../refresh/live-loader";
import type { WorkQueueTask } from "../github/work-queue";
import type { EvidenceReport } from "../github/evidence-types";
import type { Runtime } from "../github/mobile-workspace";
import { demoQueue, demoEvidence, demoDashboard } from "./sample-data";

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
  const closedDone: WorkQueueTask = { ...base, issueState: "closed", stateReason: "completed", description: "Completion type: nondeploy" };
  // Issue #119: no matching issue evidence → unknown, never "no open PR".
  assert.equal(run(closedDone).projects[0].counts.completed, 0);
  assert.equal(run(closedDone).projects[0].tasks[0].completion, "unknown");
});
test("fail-closed (#119): closed nondeploy with an open linked PR, then evidence lost/errored/truncated/absent → never complete", () => {
  const t: WorkQueueTask = { id: "1", title: "t", status: "done", agent: "claude", url: "", dependsOn: [], issueState: "closed", stateReason: "completed", description: "Completion type: nondeploy" };
  const ev = demoEvidence("empty"); const mk = (over: Partial<EvidenceReport["limits"]> = {}, issues: EvidenceReport["issues"] = []) => ({ ...ev, limits: { ...ev.limits, ...over }, issues });
  const run = (evidence: Live<EvidenceReport>) => buildWorkspaceModel({ queue: ok([t]), evidence, runtime: ok(demoDashboard("empty") as unknown as Runtime) }).projects[0].tasks[0];
  const base = { number: 1, title: "t", url: "", state: "closed" as const, agent: "claude", status: "done", acks: [], completions: [], comments: 0, pulls: [], nextAction: { code: "x", label: "x", actor: "pm" } } as unknown as EvidenceReport["issues"][number];
  const pullOf = (o: object) => ({ number: 9, url: "", title: "", state: "open", draft: false, base: "main", head: "x", headSha: "a".repeat(40), linkedBy: ["body"], commits: { count: 1, truncated: false }, reviews: [], comments: [], revisions: 0, detail: "loaded", ...o });
  assert.equal(run(ok(mk({}, [base]))).complete, true, "control: covered issue, no open PR → complete");
  const open = { ...base, pulls: [pullOf({})] } as unknown as typeof base;
  assert.equal(run(ok(mk({}, [open]))).complete, false, "open linked PR");
  for (const e of [{ kind: "error", detail: "x" }, { kind: "unconfigured" }, { kind: "loading" }] as Live<EvidenceReport>[]) assert.equal(run(e).complete, false);
  for (const k of ["issuesTruncated", "pullsTruncated", "commentsTruncated"] as const) { const r = run(ok(mk({ [k]: true }, [base]))); assert.equal(r.complete, false, k); assert.equal(r.completion, "unknown", k); }
  assert.equal(run(ok(mk({}, []))).complete, false, "absent matching issue");
});
test("agent aliases (#119): claude-sonnet/claude-opus resolve to Sonnet/Opus", async () => {
  const { normalizeAgent } = await import("./model");
  assert.equal(normalizeAgent("claude-sonnet"), "sonnet"); assert.equal(normalizeAgent("claude-opus"), "opus");
  const { AI_NAMES } = await import("../github/mobile-workspace");
  assert.equal(AI_NAMES["claude-opus"], "Claude Opus");
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
