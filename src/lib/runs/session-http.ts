// #55 — POST /api/collaboration/session: the routine-SESSION compatibility channel (see session-auth.ts for trust).
//
// Same atomic gate v2 decision as the HMAC worker (control ON/provider/schedule AND an orchestrator-authorized live
// dispatch for exactly (issue, agent)), same atomic one-writer claim and the same #41/#49 writer fence. Differences:
//  - auth is a proxy-injected per-agent static header, not an HMAC; responses are unsigned (TLS only);
//  - every action carries the exact targetSha of the dispatch (stale SHA => 409) and a one-time x-event-id;
//  - the run is recorded with runOrigin "session": only this channel can lease/finish it, and the runner channel can
//    neither lease/finish/quiesce it. A session result is stored as an unverified self-report WITHOUT cleanup proof,
//    so the run is never provablyQuiescent; a later writer claim / PM revise on that workflow stays fenced.
//  - quiesce / cleanup_failed are refused: a session cannot attest process-group cleanup.
import { verifySession } from "./session-auth";
import { checkExternalGate } from "./external-gate";
import { claimCollaboration, finishCollaboration, leaseCollaboration, type SessionExecutionResult } from "./collaboration";
import { validSha } from "./collaboration-github";
import { deliver, failure, type Dependencies, type Reply } from "./collaboration-http";

const reply = (status: number, data: unknown): Reply => ({ status, body: JSON.stringify({ trust: "external_session", ...(data as object) }) });
const RUN_ID = /^[A-Za-z0-9._-]{8,128}$/;
const DISPATCH_ID = /^[A-Za-z0-9>._-]{1,128}$/;

/** One-time event id in the SAME durable table as HMAC events (cross-channel replay is rejected too). */
async function consume(d: Dependencies, eventId: string, at: string) {
  return d.store().transact(s => { if (s.events[eventId]) return false; s.events[eventId] = at; return true; });
}

export async function handleSession(headers: Headers, raw: string, d: Dependencies): Promise<Reply> {
  if (raw.length > 16_384) return reply(413, { error: "too_large" });
  const auth = verifySession(headers, d.env, d.nowMs);
  // Generic error body: do not reveal which check failed or whether a token is configured for another agent.
  if (!auth.ok) return reply(auth.status, { error: auth.status === 503 ? "session_auth_unavailable" : "unauthorized" });
  const agent = auth.agent, eventId = headers.get("x-event-id")!, at = new Date(d.nowMs).toISOString();
  let b; try { b = JSON.parse(raw); } catch { return reply(400, { error: "bad_request" }); }
  if (!b || typeof b !== "object" || b.v !== 1 || b.agent !== agent || !Number.isSafeInteger(b.issueNumber) || b.issueNumber <= 0 ||
      (b.dispatchId !== undefined && (typeof b.dispatchId !== "string" || !DISPATCH_ID.test(b.dispatchId)))) return reply(400, { error: "bad_request" });
  if (b.action === "quiesce" || b.action === "cleanup_failed") return reply(400, { error: "unsupported_for_session" });
  try {
    if (b.action === "gate") {
      const g = await checkExternalGate(d.store(), { agent, issueNumber: b.issueNumber, dispatchId: b.dispatchId }, eventId, at);
      if (!g.ok) return reply(g.reason === "replay" ? 409 : 400, { allow: false, error: g.reason });
      const rec = g.allow && g.dispatchId ? (await d.store().read()).records[g.dispatchId] : undefined;
      const c = rec?.collaboration;
      // Only collaboration dispatches carry the exact SHA/branch binding this channel requires.
      if (g.allow && (!c || c.step !== "claude")) return reply(200, { allow: false, reason: "not_session_step", agent, issueNumber: b.issueNumber, at, eventId });
      return reply(200, { allow: g.allow, reason: g.reason, agent, issueNumber: b.issueNumber, dispatchId: g.dispatchId, at, eventId,
        task: c ? { repo: c.repo, baseBranch: c.baseBranch, baseSha: c.baseSha, workBranch: c.workBranch, targetSha: c.targetSha, prNumber: c.prNumber ?? null, step: c.step, cycle: c.cycle, instructions: c.instructions } : null });
    }
    if (typeof b.dispatchId !== "string" || typeof b.runId !== "string" || !RUN_ID.test(b.runId) || !validSha(b.targetSha)) return reply(400, { error: "bad_request" });
    const rec = (await d.store().read()).records[b.dispatchId];
    if (!rec?.collaboration || rec.agent !== agent || rec.issueNumber !== b.issueNumber) return reply(409, { error: "dispatch_mismatch" });
    if (rec.collaboration.targetSha !== b.targetSha) return reply(409, { error: "stale_target_sha" });
    if (b.action === "claim") {
      const gate = await checkExternalGate(d.store(), { agent, issueNumber: b.issueNumber, dispatchId: b.dispatchId }, eventId, at);
      if (!gate.ok) return reply(gate.reason === "replay" ? 409 : 400, { error: gate.reason });
      if (!gate.allow) return reply(409, { error: gate.reason });
      const r = await claimCollaboration(d.store(), b.dispatchId, agent, b.runId, at, { origin: "session", targetSha: b.targetSha });
      return reply(200, { record: { dispatchId: r.dispatchId, agent: r.agent, issueNumber: r.issueNumber, runId: r.runId, runOrigin: r.runOrigin, status: r.status, collaboration: r.collaboration }, at, eventId });
    }
    if (b.action !== "lease" && b.action !== "finish") return reply(400, { error: "bad_request" });
    if (!await consume(d, eventId, at)) return reply(409, { error: "replay" });
    if (b.action === "lease") return reply(200, { ...(await leaseCollaboration(d.store(), b.dispatchId, agent, b.runId, at, "session")), at, eventId });
    const w = await finishCollaboration(d.store(), d.github, b.dispatchId, agent, b.runId, b.result as SessionExecutionResult, at, "session");
    return reply(200, { workflow: { id: w.id, stage: w.stage, cycle: w.cycle, dispatchId: w.dispatchId, latest: w.latest }, submission: await deliver(d, w), at, eventId,
      note: "self-reported session result; no process-cleanup proof recorded" });
  } catch (e) {
    const f = failure(e);
    return { ...f, body: JSON.stringify({ trust: "external_session", ...JSON.parse(f.body) }) };
  }
}
