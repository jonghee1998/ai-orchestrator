// Issue #31 — enforceable gate for EXTERNAL trigger paths (scheduled routines / webhooks).
//
// What this can and cannot do: the orchestrator cannot stop an external routine from starting. It CAN
// give routines a signed "may I run?" endpoint that evaluates the same atomic gate as dispatch, and record
// signed evidence that a routine consulted it. A routine that never calls it stays UNCONTROLLED — the
// dashboard therefore shows per-agent "evidence age" and never claims control without fresh evidence.
import { createHmac } from "node:crypto";
import type { RunStore } from "./store";
import { evaluateGate, isAgentKey, type GateReason } from "../control/model";
import { appendAudit } from "../control/service";

export type GateCheckResult =
  | { ok: true; allow: boolean; reason: GateReason | null; agent: string; at: string; eventId: string }
  | { ok: false; reason: "unknown_agent" | "replay" };

/** Atomic with control state. Disabled/unknown => allow:false (fail closed). Replayed event IDs are rejected. */
export async function checkExternalGate(store: RunStore, agent: string, eventId: string, now: string): Promise<GateCheckResult> {
  return store.transact((d): GateCheckResult => {
    if (!isAgentKey(agent)) return { ok: false, reason: "unknown_agent" };
    if (d.events[eventId]) return { ok: false, reason: "replay" };
    d.events[eventId] = now;
    const g = evaluateGate(d.control, agent, Date.parse(now));
    const prev = d.gateChecks[agent];
    d.gateChecks[agent] = { at: now, allowed: g.allowed, reason: g.allowed ? null : g.reason, count: (prev?.count ?? 0) + 1 };
    if (!g.allowed) {
      d.blocked[agent] = (d.blocked[agent] ?? 0) + 1;
      appendAudit(d, "gate", "external_blocked", `external routine agent=${agent} reason=${g.reason}`, now);
    }
    return { ok: true, allow: g.allowed, reason: g.allowed ? null : g.reason, agent, at: now, eventId };
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
