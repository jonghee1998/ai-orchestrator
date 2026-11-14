// Issue #31/#34 — enforceable gate for EXTERNAL trigger paths (scheduled routines / webhooks).
//
// What this can and cannot do: the orchestrator cannot stop an external routine from starting. It CAN
// give routines a signed "may I run THIS task?" endpoint that evaluates the same atomic gate as dispatch,
// and record signed evidence that a routine consulted it. A routine that never calls it stays UNCONTROLLED.
//
// v2 (#34):
//  - The request is signed with a PER-AGENT secret (RUN_CALLBACK_SECRET_<AGENT_KEY>, e.g. _CLAUDE_OPUS);
//    there is no provider-wide fallback, so a Sonnet secret cannot mint an Opus check.
//  - The agent key and issue number are inside the SIGNED body and must match the header, so neither can be
//    swapped in transit.
//  - Task-specific authorization: allow only if the orchestrator itself authorized a submission for exactly
//    (issueNumber, agent) and that dispatch is live (not held / terminal). A label added by hand => deny.
import { createHmac } from "node:crypto";
import type { RunStore } from "./store";
import type { DispatchRecord } from "./run-tracking";
import { evaluateGate, isAgentKey, type GateReason } from "../control/model";
import { appendAudit } from "../control/service";

export type TaskDenyReason = "no_authorized_dispatch" | "dispatch_mismatch" | "dispatch_held" | "dispatch_finished";
export type GateDenyReason = GateReason | TaskDenyReason;

export interface GateRequest { agent: string; issueNumber: number; dispatchId?: string }

export type GateCheckResult =
  | { ok: true; allow: boolean; reason: GateDenyReason | null; agent: string; issueNumber: number; dispatchId: string | null; at: string; eventId: string }
  | { ok: false; reason: "unknown_agent" | "replay" };

/** Parses + validates the signed JSON body. Returns null on any malformation (caller => 400, allow:false). */
export function parseGateRequest(rawBody: string): GateRequest | null {
  let b: unknown;
  try { b = JSON.parse(rawBody); } catch { return null; }
  if (!b || typeof b !== "object") return null;
  const o = b as Record<string, unknown>;
  if (o.v !== 2 || typeof o.agent !== "string" || !Number.isSafeInteger(o.issueNumber) || (o.issueNumber as number) <= 0) return null;
  if (o.dispatchId !== undefined && (typeof o.dispatchId !== "string" || !/^[A-Za-z0-9>._-]{1,128}$/.test(o.dispatchId))) return null;
  return { agent: o.agent, issueNumber: o.issueNumber as number, dispatchId: o.dispatchId as string | undefined };
}

/** A dispatch the orchestrator itself let through authorizeSubmission and that has not ended. */
function authorizedDispatch(records: DispatchRecord[], req: GateRequest): { rec: DispatchRecord } | { deny: TaskDenyReason } {
  const mine = records.filter((r) => r.issueNumber === req.issueNumber && r.agent === req.agent);
  if (req.dispatchId && !mine.some((r) => r.dispatchId === req.dispatchId)) return { deny: mine.length ? "dispatch_mismatch" : "no_authorized_dispatch" };
  const cands = req.dispatchId ? mine.filter((r) => r.dispatchId === req.dispatchId) : mine;
  const live = cands.find((r) => !r.held && ((r.status === "queued" && !!r.submitAuthorizedAt) || ["dispatched", "acknowledged", "running"].includes(r.status)));
  if (live) return { rec: live };
  if (cands.some((r) => r.held)) return { deny: "dispatch_held" };
  if (cands.some((r) => ["succeeded", "failed", "timeout"].includes(r.status))) return { deny: "dispatch_finished" };
  return { deny: "no_authorized_dispatch" };
}

/** Atomic with control state + records. Any doubt => allow:false (fail closed). Replayed event IDs are rejected. */
export async function checkExternalGate(store: RunStore, req: GateRequest, eventId: string, now: string): Promise<GateCheckResult> {
  return store.transact((d): GateCheckResult => {
    const { agent, issueNumber } = req;
    if (!isAgentKey(agent)) return { ok: false, reason: "unknown_agent" };
    if (d.events[eventId]) return { ok: false, reason: "replay" };
    d.events[eventId] = now;
    const g = evaluateGate(d.control, agent, Date.parse(now));
    let reason: GateDenyReason | null = g.allowed ? null : g.reason;
    let dispatchId: string | null = null;
    if (!reason) {
      const t = authorizedDispatch(Object.values(d.records), req);
      if ("deny" in t) reason = t.deny; else dispatchId = t.rec.dispatchId;
    }
    const allow = reason === null;
    const prev = d.gateChecks[agent];
    d.gateChecks[agent] = { at: now, allowed: allow, reason, count: (prev?.count ?? 0) + 1 };
    if (!allow) {
      d.blocked[agent] = (d.blocked[agent] ?? 0) + 1;
      appendAudit(d, "gate", "external_blocked", `external routine agent=${agent} issue=#${issueNumber} reason=${reason}`, now);
    } else {
      appendAudit(d, "gate", "external_allowed", `external routine agent=${agent} issue=#${issueNumber} dispatch=${dispatchId}`, now);
    }
    return { ok: true, allow, reason, agent, issueNumber, dispatchId, at: now, eventId };
  });
}

/** Response signature so a routine can verify the answer came from the orchestrator (not a spoofed 200). */
export function signGateResponse(secret: string, at: string, eventId: string, body: string): string {
  return createHmac("sha256", secret).update(`${at}.${eventId}.${body}`).digest("hex");
}

/** Evidence freshness: "fresh" only if a signed check was recorded within maxAgeMs. */
export function gateEvidence(c: { at: string; allowed: boolean; count: number } | undefined, nowMs: number, maxAgeMs = 24 * 3600_000) {
  if (!c) return { state: "none" as const };
  const age = nowMs - Date.parse(c.at);
  return { state: age <= maxAgeMs ? ("fresh" as const) : ("stale" as const), lastAt: c.at, lastAllowed: c.allowed, count: c.count };
}
