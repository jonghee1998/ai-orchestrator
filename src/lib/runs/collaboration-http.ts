import { agentSecret, verifyCallback } from "./callback-auth";
import { authorize } from "../session/guard";
import { isAgentKey } from "../control/model";
import { checkExternalGate, signGateResponse } from "./external-gate";
import { assignCollaboration, claimCollaboration, finishCollaboration, leaseCollaboration, quiesceCollaboration, reportCleanupFailure, type QuiescenceReport, type CleanupFailure, decideCollaboration, refreshCollaboration, CollaborationConflict, type Assignment, type ExecutionResult } from "./collaboration";
import { CollaborationGitHubError, type CollaborationGitHub } from "./collaboration-github";
import { submitQueued, type DispatchAdapter } from "./dispatcher";
import { RunStoreConfigurationError, type RunStore } from "./store";

type Env = Readonly<Record<string, string | undefined>>;
export interface Dependencies { store: () => RunStore; github: CollaborationGitHub; adapter: DispatchAdapter; env: Env; nowMs: number }
export interface Reply { status: number; body: string; signature?: string }
const reply = (status: number, data: unknown): Reply => ({ status, body: JSON.stringify(data) });
const at = (d: Dependencies) => new Date(d.nowMs).toISOString();
export async function deliver(d: Dependencies, w: { dispatchId?: string; stage: string }) {
  if (!w.dispatchId || !["claude", "codex"].includes(w.stage)) return null;
  // Durable one-shot authorization also prevents duplicate submissions after a lost HTTP response.
  return submitQueued(d.store(), d.adapter, w.dispatchId, at(d));
}
export async function handleCollaboration(method: string, headers: Headers, raw: string, d: Dependencies): Promise<Reply> {
  try {
    const auth = authorize(method, headers, method === "GET" ? "read" : "admin", d.env, d.nowMs);
    if (!auth.ok) return reply(auth.status, { error: "unauthorized" });
    if (method === "GET") return reply(200, { workflows: Object.values((await d.store().read()).collaborations ?? {}) });
    if (raw.length > 16_384) return reply(413, { error: "too_large" });
    let b; try { b = JSON.parse(raw); } catch { return reply(400, { error: "bad_request" }); }
    if (!b || typeof b !== "object") return reply(400, { error: "bad_request" });
    let w;
    if (b.action === "assign" && b.assignment?.repo === d.env.GITHUB_REPO) w = await assignCollaboration(d.store(), d.github, b.assignment as Assignment, at(d));
    else if (b.action === "decide") w = await decideCollaboration(d.store(), d.github, b.workflowId, b.sha, b.decision, b.feedback, at(d), b.acknowledgeUnknownExecution === true);
    else if (b.action === "refresh") w = await refreshCollaboration(d.store(), d.github, b.workflowId, at(d));
    else if (b.action === "submit" && typeof b.dispatchId === "string") {
      const r = (await d.store().read()).records[b.dispatchId];
      if (!r?.collaboration) return reply(404, { error: "unknown_dispatch" });
      return reply(200, { submission: await submitQueued(d.store(), d.adapter, b.dispatchId, at(d)) });
    } else return reply(400, { error: "bad_request" });
    return reply(200, { workflow: w, submission: await deliver(d, w) });
  } catch (e) { return failure(e); }
}
export function failure(e: unknown): Reply {
  if (e instanceof CollaborationConflict) return reply(409, { error: e.message });
  if (e instanceof RunStoreConfigurationError) return reply(503, { error: "store_unconfigured" });
  if (e instanceof CollaborationGitHubError) return reply(502, { error: e.message });
  return reply(500, { error: "collaboration_error" });
}
/** Worker API uses the SAME per-agent HMAC and task-specific gate as PR #35. Signed responses bind context. */
export async function handleCollaborationWorker(headers: Headers, raw: string, d: Dependencies): Promise<Reply> {
  if (raw.length > 16_384) return reply(413, { error: "too_large" });
  const agent = headers.get("x-agent-key") ?? "", eventId = headers.get("x-event-id");
  if (!isAgentKey(agent) || agent === "gpt") return reply(401, { error: "unauthorized" });
  const secret = agentSecret(agent, d.env);
  const auth = verifyCallback({ secret, timestamp: headers.get("x-timestamp"), eventId, signature: headers.get("x-signature"), rawBody: raw, nowMs: d.nowMs });
  if (!auth.ok) return reply(auth.reason === "missing_secret" ? 503 : 401, { error: "unauthorized" });
  let b; try { b = JSON.parse(raw); } catch { return reply(400, { error: "bad_request" }); }
  if (!b || b.v !== 2 || b.agent !== agent || typeof b.dispatchId !== "string" || typeof b.runId !== "string" || !Number.isSafeInteger(b.issueNumber) || b.issueNumber <= 0) return reply(400, { error: "bad_request" });
  let r: Reply;
  try {
    const rec = (await d.store().read()).records[b.dispatchId];
    if (!rec?.collaboration || rec.agent !== agent || rec.issueNumber !== b.issueNumber) return reply(409, { error: "dispatch_mismatch" });
    if (b.action === "claim") {
      const gate = await checkExternalGate(d.store(), { agent, issueNumber: b.issueNumber, dispatchId: b.dispatchId }, eventId!, at(d));
      if (!gate.ok || !gate.allow) return reply(409, { error: gate.ok ? gate.reason : gate.reason });
      r = reply(200, { record: await claimCollaboration(d.store(), b.dispatchId, agent, b.runId, at(d)), eventId, at: at(d) });
    } else if (b.action === "lease") {
      r = reply(200, { ...(await leaseCollaboration(d.store(), b.dispatchId, agent, b.runId, at(d))), eventId, at: at(d) });
    } else if (b.action === "quiesce") {
      r = reply(200, { record: await quiesceCollaboration(d.store(), b.dispatchId, agent, b.runId, b.quiescence as QuiescenceReport, at(d)), eventId, at: at(d) });
    } else if (b.action === "cleanup_failed") {
      r = reply(200, { record: await reportCleanupFailure(d.store(), b.dispatchId, agent, b.runId, b.failure as CleanupFailure, at(d)), eventId, at: at(d) });
    } else if (b.action === "finish") {
      // runId + terminal-result comparison makes a lost completion response safely replayable.
      const w = await finishCollaboration(d.store(), d.github, b.dispatchId, agent, b.runId, b.result as ExecutionResult, at(d));
      r = reply(200, { workflow: w, submission: await deliver(d, w), eventId, at: at(d) });
    } else return reply(400, { error: "bad_request" });
  } catch (e) { r = failure(e); }
  return { ...r, signature: signGateResponse(secret!, at(d), eventId!, r.body) };
}
