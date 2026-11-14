// Issue #36: durable, revision-bound subscription collaboration. No model API calls.
import { randomUUID } from "node:crypto";
import type { RunStore, StoreData } from "./store";
import { createDispatch, isTerminal, type DispatchRecord } from "./run-tracking";
import { evaluateGate } from "../control/model";
import { appendAudit } from "../control/service";
import { validBranch, validRepo, validSha, type CollaborationGitHub, type PullSnapshot } from "./collaboration-github";

export interface Assignment {
  repo: string; issueNumber: number; baseBranch: string; baseSha: string; sourcePr: number;
  workBranch: string; claudeAgent: "claude-sonnet" | "claude-opus"; instructions: string;
  /** Adopt Claude's completed source PR and start Codex review, otherwise start Claude development. */
  reviewCompletedPr: boolean;
}
export interface Collaboration {
  id: string; assignment: Assignment; cycle: number; stage: "claude" | "codex" | "pm" | "approved" | "blocked";
  dispatchId?: string; latest?: PullSnapshot; feedback: string; updatedAt: string;
  history: { at: string; action: string; dispatchId?: string; sha?: string; detail?: string }[];
}
export interface ExecutionResult {
  exitCode: number; headSha: string; summary: string; tests: { command: string; exitCode: number }[]; prNumber?: number;
}
export class CollaborationConflict extends Error {}
function conflict(reason: string): never { throw new CollaborationConflict(reason); }
export function validAssignment(a: Assignment): boolean {
  return !!a && validRepo(a.repo) && Number.isSafeInteger(a.issueNumber) && a.issueNumber > 0 &&
    validBranch(a.baseBranch) && validSha(a.baseSha) && Number.isSafeInteger(a.sourcePr) && a.sourcePr > 0 &&
    validBranch(a.workBranch) && !["main", "master", a.baseBranch].includes(a.workBranch) &&
    ["claude-sonnet", "claude-opus"].includes(a.claudeAgent) && typeof a.reviewCompletedPr === "boolean" &&
    typeof a.instructions === "string" && a.instructions.trim().length > 0 && a.instructions.length <= 8000;
}
export function validExecution(r: ExecutionResult): boolean {
  return !!r && Number.isInteger(r.exitCode) && r.exitCode >= 0 && r.exitCode <= 255 && validSha(r.headSha) &&
    typeof r.summary === "string" && r.summary.trim().length > 0 && r.summary.length <= 4000 &&
    Array.isArray(r.tests) && r.tests.length <= 30 && r.tests.every(t => t && typeof t.command === "string" && t.command.length > 0 && t.command.length <= 500 && Number.isInteger(t.exitCode) && t.exitCode >= 0 && t.exitCode <= 255) &&
    (r.prNumber === undefined || (Number.isSafeInteger(r.prNumber) && r.prNumber > 0));
}
const workflow = (d: StoreData, id: string) => d.collaborations?.[id] ?? conflict("unknown_workflow");
function note(w: Collaboration, at: string, action: string, detail?: string) {
  w.updatedAt = at;
  w.history.push({ at, action, detail, dispatchId: w.dispatchId, sha: w.latest?.headSha });
}
/** Queue only. submitQueued performs the existing atomic OFF/schedule/provider gate before labels. */
function queue(d: StoreData, w: Collaboration, step: "claude" | "codex", at: string) {
  const a = w.assignment;
  const agent = step === "codex" ? "codex" : a.claudeAgent;
  const dispatchId = `w-${w.id}-${w.cycle}-${step}`;
  if (d.records[dispatchId]) conflict("duplicate_step");
  const rec: DispatchRecord = { ...createDispatch(a.issueNumber, agent, at, w.cycle), dispatchId,
    capability: step === "codex" ? "review" : "develop",
    collaboration: { workflowId: w.id, cycle: w.cycle, step, repo: a.repo, baseBranch: a.baseBranch, baseSha: a.baseSha,
      workBranch: a.workBranch, targetSha: w.latest?.headSha ?? a.baseSha, prNumber: w.latest?.number,
      instructions: `${a.instructions}\nPM feedback: ${w.feedback}` } };
  d.records[dispatchId] = rec;
  w.stage = step; w.dispatchId = dispatchId;
  note(w, at, "queued");
}
export async function assignCollaboration(store: RunStore, github: CollaborationGitHub, a: Assignment, at: string) {
  if (!validAssignment(a)) conflict("invalid_assignment");
  const sha = await github.branch(a.repo, a.baseBranch);
  const pr = await github.pull(a.repo, a.sourcePr);
  if (sha !== a.baseSha || pr.headSha !== a.baseSha || pr.headBranch !== a.baseBranch || pr.repo !== a.repo) conflict("baseline_mismatch");
  return store.transact(d => {
    const all = d.collaborations ??= {};
    if (Object.values(all).some(w => w.assignment.repo === a.repo && w.assignment.issueNumber === a.issueNumber)) conflict("assignment_exists");
    if (Object.values(d.records).some(r => r.issueNumber === a.issueNumber && !isTerminal(r.status))) conflict("active_dispatch_exists");
    const w: Collaboration = { id: randomUUID(), assignment: structuredClone(a), cycle: 1, stage: "claude", feedback: "", updatedAt: at, history: [] };
    all[w.id] = w;
    if (a.reviewCompletedPr) w.latest = pr;
    queue(d, w, a.reviewCompletedPr ? "codex" : "claude", at);
    appendAudit(d, "pm", "collaboration_assigned", `issue=#${a.issueNumber} base=${a.baseBranch}@${a.baseSha} sourcePr=#${a.sourcePr}`, at);
    return structuredClone(w);
  });
}

/** Called only after per-agent HMAC verification AND gate v2. Atomic claim prevents multiple routine workers. */
export async function claimCollaboration(store: RunStore, id: string, agent: string, runId: string, at: string) {
  return store.transact(d => {
    const r = d.records[id];
    if (!r?.collaboration || r.agent !== agent || !r.submitAuthorizedAt || r.held || r.status !== "dispatched" || !["accepted", "unknown"].includes(r.submission ?? "")) conflict("not_claimable");
    const w = workflow(d, r.collaboration.workflowId);
    if (w.dispatchId !== id || w.stage !== r.collaboration.step) conflict("stale_step");
    const gate = evaluateGate(d.control, agent, Date.parse(at));
    if (!gate.allowed) conflict(gate.reason);
    if (!/^[A-Za-z0-9._-]{8,128}$/.test(runId)) conflict("invalid_run_id");
    d.records[id] = { ...r, status: "running", runId, ackAt: at, startedAt: at, lastHeartbeatAt: at, source: "agent-callback" };
    note(w, at, "claimed");
    return structuredClone(d.records[id]);
  });
}
function matches(w: Collaboration, p: PullSnapshot) {
  const a = w.assignment;
  // The original completed Claude PR is a review target, never a mutation target.
  return p.repo === a.repo && ((p.number === a.sourcePr && p.headBranch === a.baseBranch && p.headSha === a.baseSha) ||
    (p.open && p.headBranch === a.workBranch && p.baseBranch === a.baseBranch));
}
/** Completion advances the next step in the SAME transaction as the execution result. Labels are not completion. */
export async function finishCollaboration(store: RunStore, github: CollaborationGitHub, id: string, agent: string, runId: string, result: ExecutionResult, at: string) {
  if (!validExecution(result)) conflict("invalid_result");
  const before = await store.read();
  const rec = before.records[id];
  if (!rec?.collaboration || rec.agent !== agent) conflict("dispatch_mismatch");
  const prior = workflow(before, rec.collaboration.workflowId);
  // Only successful results need PR evidence. Failures still persist actual exit code and block the loop.
  const ok = result.exitCode === 0 && result.tests.length > 0 && result.tests.every(t => t.exitCode === 0);
  const p = ok ? await github.pull(prior.assignment.repo, result.prNumber ?? rec.collaboration.prNumber ?? conflict("missing_pr")) : undefined;
  if (p && (!matches(prior, p) || p.headSha !== result.headSha ||
    (rec.collaboration.step === "codex" && (p.number !== rec.collaboration.prNumber || p.headSha !== rec.collaboration.targetSha)))) conflict("stale_or_unrelated_pr");
  if (p && !await github.descendsFrom(prior.assignment.repo, prior.assignment.baseSha, p.headSha)) conflict("baseline_not_ancestor");
  return store.transact(d => {
    const r = d.records[id], w = workflow(d, prior.id);
    if (r.runId !== runId || r.agent !== agent) conflict("run_mismatch");
    if (isTerminal(r.status)) {
      if (JSON.stringify(r.execution) === JSON.stringify({ exitCode: result.exitCode, headSha: result.headSha, summary: result.summary, tests: result.tests })) return structuredClone(w);
      conflict("already_finished");
    }
    if (r.status !== "running" || w.dispatchId !== id || w.stage !== r.collaboration?.step) conflict("stale_step");
    d.records[id] = { ...r, status: ok ? "succeeded" : "failed", finishedAt: at, lastActivityAt: at,
      execution: { exitCode: result.exitCode, headSha: result.headSha, summary: result.summary, tests: structuredClone(result.tests) },
      lastError: ok ? undefined : "execution or required tests failed", evidence: p ? [...r.evidence, { kind: "pr", url: p.url, at }] : r.evidence };
    if (p) w.latest = p;
    note(w, at, ok ? "completed" : "execution_failed", result.summary);
    if (!ok) { w.stage = "blocked"; }
    else if (r.collaboration!.step === "claude") queue(d, w, "codex", at);
    else { w.stage = "pm"; note(w, at, "awaiting_pm"); }
    return structuredClone(w);
  });
}
/** GPT PM remains a subscription/manual handoff: no fabricated ChatGPT dispatch or paid API. */
export async function decideCollaboration(store: RunStore, github: CollaborationGitHub, id: string, sha: string, decision: "approve" | "revise", feedback: string, at: string) {
  if (!validSha(sha) || !["approve", "revise"].includes(decision) || typeof feedback !== "string" || !feedback.trim() || feedback.length > 4000) conflict("invalid_decision");
  const before = workflow(await store.read(), id);
  if (!["pm", "blocked"].includes(before.stage) || (before.stage === "blocked" && decision !== "revise")) conflict("not_awaiting_pm");
  const p = await github.pull(before.assignment.repo, before.latest?.number ?? before.assignment.sourcePr);
  if (!await github.descendsFrom(before.assignment.repo, before.assignment.baseSha, p.headSha)) conflict("baseline_not_ancestor");
  return store.transact(d => {
    const w = workflow(d, id);
    if (w.stage !== before.stage || w.latest?.headSha !== before.latest?.headSha || w.dispatchId !== before.dispatchId) conflict("stale_decision");
    if (!matches(w, p)) conflict("unrelated_pr");
    if (sha !== (w.latest?.headSha ?? w.assignment.baseSha)) conflict("stale_decision");
    if (p.headSha !== sha) {
      // New commits invalidate both review and PM decision. Review the actual latest HEAD once.
      w.latest = p; w.cycle++; queue(d, w, "codex", at); note(w, at, "review_invalidated");
      return structuredClone(w);
    }
    w.feedback = feedback;
    note(w, at, `pm_${decision}`, feedback);
    appendAudit(d, "pm", `collaboration_${decision}`, `${id} pr=#${p.number} sha=${sha}`, at);
    if (decision === "approve") { w.stage = "approved"; }
    else { w.cycle++; queue(d, w, "claude", at); }
    return structuredClone(w); // approval NEVER merges or deploys
  });
}

/** Poll a tracked PR, invalidating old reviews when GitHub reports a newer commit. Never changes the PM baseline. */
export async function refreshCollaboration(store: RunStore, github: CollaborationGitHub, id: string, at: string) {
  const before = workflow(await store.read(), id);
  if (!before.latest) conflict("no_tracked_pr");
  const p = await github.pull(before.assignment.repo, before.latest.number);
  if (!await github.descendsFrom(before.assignment.repo, before.assignment.baseSha, p.headSha)) conflict("baseline_not_ancestor");
  return store.transact(d => {
    const w = workflow(d, id);
    if (w.dispatchId !== before.dispatchId || w.latest?.headSha !== before.latest!.headSha) conflict("stale_refresh");
    if (!matches(w, p)) conflict("unrelated_pr");
    if (p.headSha === w.latest?.headSha) return structuredClone(w);
    if (w.stage === "claude") conflict("development_in_progress");
    const r = w.dispatchId ? d.records[w.dispatchId] : undefined;
    if (r && !isTerminal(r.status)) {
      d.records[r.dispatchId] = { ...r, status: "failed", finishedAt: at, lastError: "superseded PR HEAD; existing worker may still drain" };
    }
    w.latest = p; w.cycle++; queue(d, w, "codex", at); note(w, at, "review_invalidated");
    return structuredClone(w);
  });
}
