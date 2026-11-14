import {
  applyEvent, createDispatch, evaluateTimeout, isTerminal, type DispatchRecord, type RunEvent, DEFAULT_TIMEOUTS, type Timeouts,
} from "./run-tracking";
import type { RunStore, StoreData } from "./store";
import { AGENT_CAPS, evaluateGate, isAgentKey, routeTarget, type AgentKey, type Capability, type GateReason } from "../control/model";
import { appendAudit } from "../control/service";

/** What a provider adapter reports about a submission attempt. */
export type SubmitOutcome = "accepted" | "rejected_not_accepted" | "unknown";

export type RequestResult =
  | { ok: true; record: DispatchRecord }
  | { ok: false; reason: "already_exists" | "not_retryable" | "active_dispatch_exists" }
  | { ok: false; reason: "disabled"; gate: GateReason };

/** Gate check + suppression accounting. Runs INSIDE a store transaction (atomic with toggles and records). */
function gateOrBlock(d: StoreData, agent: string, now: string, what: string): GateReason | null {
  const g = evaluateGate(d.control, agent, Date.parse(now));
  if (g.allowed) return null;
  d.blocked[agent] = (d.blocked[agent] ?? 0) + 1;
  appendAudit(d, "gate", "dispatch_blocked", `${what} agent=${agent} reason=${g.reason}`, now);
  return g.reason;
}

const defaultCapability = (agent: string): Capability | undefined => (isAgentKey(agent) ? AGENT_CAPS[agent][0] : undefined);

/** Persist a durable dispatch ID BEFORE any provider call; duplicate requests are rejected atomically. */
export async function requestDispatch(store: RunStore, issueNumber: number, agent: string, now: string, capability?: Capability): Promise<RequestResult> {
  return store.transact((d) => {
    const blocked = gateOrBlock(d, agent, now, `request issue=#${issueNumber}`); // disabled agent never creates a record
    if (blocked) return { ok: false as const, reason: "disabled" as const, gate: blocked };
    const mine = Object.values(d.records).filter((r) => r.issueNumber === issueNumber && r.agent === agent);
    if (mine.some((r) => !isTerminal(r.status) || r.status === "succeeded")) {
      return { ok: false as const, reason: mine.some((r) => r.status === "succeeded") ? "not_retryable" as const : "already_exists" as const };
    }
    if (mine.length > 0) return { ok: false as const, reason: "already_exists" as const }; // retries must be explicit
    const rec = { ...createDispatch(issueNumber, agent, now), capability: capability ?? defaultCapability(agent) };
    d.records[rec.dispatchId] = rec;
    return { ok: true as const, record: rec };
  });
}

/** Explicit retry. Safe only if the last attempt is terminal and its submission was known not accepted. */
export async function retryDispatchRecord(store: RunStore, issueNumber: number, agent: string, now: string): Promise<RequestResult> {
  return store.transact((d) => {
    const blocked = gateOrBlock(d, agent, now, `retry issue=#${issueNumber}`); // retries are gated like first attempts
    if (blocked) return { ok: false as const, reason: "disabled" as const, gate: blocked };
    const mine = Object.values(d.records).filter((r) => r.issueNumber === issueNumber && r.agent === agent);
    if (mine.some((r) => !isTerminal(r.status))) return { ok: false as const, reason: "active_dispatch_exists" as const };
    if (mine.length === 0 || mine.some((r) => r.status === "succeeded")) return { ok: false as const, reason: "not_retryable" as const };
    const last = mine.reduce((a, b) => (a.attempt > b.attempt ? a : b));
    // Unknown submission outcome (possible lost ACK) is NOT safely retryable without idempotent provider.
    if (last.submission === "unknown" || last.submission === "accepted") return { ok: false as const, reason: "not_retryable" as const };
    const rec = { ...createDispatch(issueNumber, agent, now, last.attempt + 1), capability: last.capability };
    d.records[rec.dispatchId] = rec;
    return { ok: true as const, record: rec };
  });
}

export type SubmitAuth =
  | { ok: true; record: DispatchRecord }
  | { ok: false; reason: "unknown_dispatch" | "not_queued" }
  | { ok: false; reason: "held"; gate: GateReason; record: DispatchRecord }
  | { ok: false; reason: "rerouted"; gate: GateReason; from: DispatchRecord; to: DispatchRecord };

/**
 * MANDATORY pre-provider-call gate. Every provider submission (first attempt, retry, scheduled automation,
 * release of held work) must call this immediately before talking to the provider and abort unless ok.
 * The check is atomic with the record state, so a toggle OFF between request and submit is honoured.
 * Blocked work is HELD (no provider call, no fallback); it is rerouted only if policy + capability + an
 * enabled target all allow. Running work is never touched here (drain).
 */
export async function authorizeSubmission(store: RunStore, dispatchId: string, now: string): Promise<SubmitAuth> {
  return store.transact((d): SubmitAuth => {
    const r = d.records[dispatchId];
    if (!r) return { ok: false, reason: "unknown_dispatch" };
    if (r.status !== "queued") return { ok: false, reason: "not_queued" };
    const blocked = gateOrBlock(d, r.agent, now, `submit ${dispatchId}`);
    if (!blocked) {
      const next = { ...r, held: undefined };
      d.records[dispatchId] = next;
      return { ok: true, record: next };
    }
    const cap = r.capability as Capability | undefined;
    const target = d.control.allowReroute && cap ? routeTarget(d.control, cap, Date.parse(now), r.agent as AgentKey) : null;
    if (target) {
      const to = { ...createDispatch(r.issueNumber, target, now, 1), capability: cap, dispatchId: `${r.dispatchId}>${target}` };
      const from: DispatchRecord = { ...r, status: "failed", submission: "rejected_not_accepted", finishedAt: now, held: undefined, lastError: `rerouted to ${target} (${blocked})` };
      d.records[dispatchId] = from;
      d.records[to.dispatchId] = to;
      appendAudit(d, "gate", "rerouted", `${dispatchId} -> ${to.dispatchId} (${blocked})`, now);
      return { ok: false, reason: "rerouted", gate: blocked, from, to };
    }
    const held = { ...r, held: blocked };
    d.records[dispatchId] = held;
    return { ok: false, reason: "held", gate: blocked, record: held };
  });
}

/** Record provider submission outcome. queued -> dispatched only when accepted or unknown (unknown stays "unknown" for display). */
export async function recordSubmission(store: RunStore, dispatchId: string, outcome: SubmitOutcome, now: string, error?: string): Promise<DispatchRecord | undefined> {
  return store.transact((d) => {
    const r = d.records[dispatchId];
    if (!r || r.status !== "queued") return r;
    let next: DispatchRecord;
    if (outcome === "rejected_not_accepted") {
      next = { ...r, status: "failed", submission: outcome, finishedAt: now, lastError: error ?? "provider rejected submission" };
    } else {
      next = { ...applyEvent(r, { type: "dispatched", at: now }), submission: outcome };
    }
    d.records[dispatchId] = next;
    return next;
  });
}

export type CallbackResult =
  | { ok: true; duplicate: boolean; record?: DispatchRecord }
  | { ok: false; reason: "unknown_dispatch" | "agent_mismatch" };

/** Idempotent, atomic callback application. Replayed event IDs are no-ops. */
export async function applyCallback(store: RunStore, eventId: string, dispatchId: string, agent: string, ev: RunEvent, now: string): Promise<CallbackResult> {
  return store.transact((d) => {
    if (d.events[eventId]) return { ok: true as const, duplicate: true, record: d.records[dispatchId] };
    const r = d.records[dispatchId];
    if (!r) return { ok: false as const, reason: "unknown_dispatch" as const };
    if (r.agent !== agent) return { ok: false as const, reason: "agent_mismatch" as const };
    d.events[eventId] = now;
    const next = { ...applyEvent(r, ev), lastActivityAt: now };
    d.records[dispatchId] = next;
    return { ok: true as const, duplicate: false, record: next };
  });
}

/** Restart reconciliation: stale non-terminal records become timeout; queued-without-submission becomes unknown-failed. */
export async function reconcile(store: RunStore, now: string, t: Timeouts = DEFAULT_TIMEOUTS): Promise<number> {
  return store.transact((d) => {
    let changed = 0;
    for (const [id, r] of Object.entries(d.records)) {
      let next = evaluateTimeout(r, now, t);
      if (next.status === "queued" && !r.held && Date.parse(now) - Date.parse(r.requestedAt) > t.ackMs) {
        // Crashed between persist and submit: outcome unknown, never auto-resubmit.
        next = { ...r, status: "timeout", submission: "unknown", finishedAt: now, lastError: "submission outcome unknown after restart" };
      }
      if (next !== r) { d.records[id] = next; changed++; }
    }
    return changed;
  });
}
