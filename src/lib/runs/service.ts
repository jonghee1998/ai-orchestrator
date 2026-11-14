import {
  applyEvent, createDispatch, evaluateTimeout, isTerminal, type DispatchRecord, type RunEvent, DEFAULT_TIMEOUTS, type Timeouts,
} from "./run-tracking";
import type { RunStore } from "./store";

/** What a provider adapter reports about a submission attempt. */
export type SubmitOutcome = "accepted" | "rejected_not_accepted" | "unknown";

export type RequestResult =
  | { ok: true; record: DispatchRecord }
  | { ok: false; reason: "already_exists" | "disabled" | "not_retryable" | "active_dispatch_exists" };

/** Persist a durable dispatch ID BEFORE any provider call; duplicate requests are rejected atomically. */
export async function requestDispatch(store: RunStore, issueNumber: number, agent: string, now: string, enabled = true): Promise<RequestResult> {
  if (!enabled) return { ok: false, reason: "disabled" }; // disabled routing never creates a record
  return store.transact((d) => {
    const mine = Object.values(d.records).filter((r) => r.issueNumber === issueNumber && r.agent === agent);
    if (mine.some((r) => !isTerminal(r.status) || r.status === "succeeded")) {
      return { ok: false as const, reason: mine.some((r) => r.status === "succeeded") ? "not_retryable" as const : "already_exists" as const };
    }
    if (mine.length > 0) return { ok: false as const, reason: "already_exists" as const }; // retries must be explicit
    const rec = createDispatch(issueNumber, agent, now);
    d.records[rec.dispatchId] = rec;
    return { ok: true as const, record: rec };
  });
}

/** Explicit retry. Safe only if the last attempt is terminal and its submission was known not accepted. */
export async function retryDispatchRecord(store: RunStore, issueNumber: number, agent: string, now: string): Promise<RequestResult> {
  return store.transact((d) => {
    const mine = Object.values(d.records).filter((r) => r.issueNumber === issueNumber && r.agent === agent);
    if (mine.some((r) => !isTerminal(r.status))) return { ok: false as const, reason: "active_dispatch_exists" as const };
    if (mine.length === 0 || mine.some((r) => r.status === "succeeded")) return { ok: false as const, reason: "not_retryable" as const };
    const last = mine.reduce((a, b) => (a.attempt > b.attempt ? a : b));
    // Unknown submission outcome (possible lost ACK) is NOT safely retryable without idempotent provider.
    if (last.submission === "unknown" || last.submission === "accepted") return { ok: false as const, reason: "not_retryable" as const };
    const rec = createDispatch(issueNumber, agent, now, last.attempt + 1);
    d.records[rec.dispatchId] = rec;
    return { ok: true as const, record: rec };
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
      if (next.status === "queued" && Date.parse(now) - Date.parse(r.requestedAt) > t.ackMs) {
        // Crashed between persist and submit: outcome unknown, never auto-resubmit.
        next = { ...r, status: "timeout", submission: "unknown", finishedAt: now, lastError: "submission outcome unknown after restart" };
      }
      if (next !== r) { d.records[id] = next; changed++; }
    }
    return changed;
  });
}
