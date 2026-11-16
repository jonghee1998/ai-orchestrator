import { gateEvidence } from "../runs/external-gate";
// Phase 4 — control plane mutations, gate for non-dispatch provider calls, cancellation, monitoring snapshot.
// All mutations run in the shared serialized store transaction: concurrent toggles are linearized, every
// change bumps `version` and appends an audit entry. Monitoring (snapshot) reads the store only and
// NEVER imports or calls a provider adapter.
import { runTrust } from "../runs/run-trust";
import type { RunStore, StoreData } from "../runs/store";
import { displayStatus, isTerminal } from "../runs/run-tracking";
import {
  AGENT_KEYS, CANCEL_SUPPORT, CAPABILITIES, PRESETS, PROVIDER_OF, effectiveEnabled, evaluateGate, isAgentKey, validateSchedule,
  type AgentKey, type Capability, type ControlState, type GateDecision, type PresetName, type Schedule,
} from "./model";

const AUDIT_MAX = 500;
export function appendAudit(d: StoreData, actor: string, action: string, detail: string, at: string): void {
  d.audit.push({ at, actor, action, detail, version: d.control.version });
  if (d.audit.length > AUDIT_MAX) d.audit.splice(0, d.audit.length - AUDIT_MAX);
}

export type Mutation =
  | { action: "set_agent"; agent: string; enabled: boolean }
  | { action: "set_claude_provider"; enabled: boolean }
  | { action: "preset"; name: string }
  | { action: "set_routing"; routing: Partial<Record<string, string[]>> }
  | { action: "set_reroute"; enabled: boolean }
  | { action: "set_schedule"; schedule: Schedule };

export type MutationResult =
  | { ok: true; control: ControlState }
  | { ok: false; reason: "invalid" | "version_conflict"; detail?: string };

export async function mutateControl(store: RunStore, m: Mutation, actor: string, now: string, expectedVersion?: number): Promise<MutationResult> {
  return store.transact((d): MutationResult => {
    const c = d.control;
    if (expectedVersion !== undefined && expectedVersion !== c.version) return { ok: false, reason: "version_conflict", detail: `current=${c.version}` };
    let detail: string;
    const next: ControlState = structuredClone(c);
    switch (m.action) {
      case "set_agent":
        if (!isAgentKey(m.agent) || typeof m.enabled !== "boolean") return { ok: false, reason: "invalid", detail: "agent/enabled" };
        next.agents[m.agent] = m.enabled; next.preset = "custom"; detail = `${m.agent}=${m.enabled ? "ON" : "OFF"}`; break;
      case "set_claude_provider":
        if (typeof m.enabled !== "boolean") return { ok: false, reason: "invalid", detail: "enabled" };
        next.claudeProvider = m.enabled; next.preset = "custom"; detail = `claude-provider=${m.enabled ? "ON" : "OFF"}`; break;
      case "preset": {
        if (!Object.hasOwn(PRESETS, m.name)) return { ok: false, reason: "invalid", detail: "preset" };
        const p = PRESETS[m.name as PresetName];
        next.agents = { ...p.agents }; next.claudeProvider = p.claudeProvider; next.preset = m.name as PresetName; detail = `preset=${m.name}`; break;
      }
      case "set_routing": {
        for (const [cap, list] of Object.entries(m.routing ?? {})) {
          if (!CAPABILITIES.includes(cap as Capability) || !Array.isArray(list) || !list.every(isAgentKey)) return { ok: false, reason: "invalid", detail: `routing.${cap}` };
          next.routing[cap as Capability] = [...new Set(list as AgentKey[])];
        }
        next.preset = "custom"; detail = `routing=${JSON.stringify(next.routing)}`; break;
      }
      case "set_reroute":
        if (typeof m.enabled !== "boolean") return { ok: false, reason: "invalid", detail: "enabled" };
        next.allowReroute = m.enabled; detail = `allowReroute=${m.enabled}`; break;
      case "set_schedule": {
        const err = m.schedule && typeof m.schedule === "object" ? validateSchedule(m.schedule) : "invalid schedule";
        if (err) return { ok: false, reason: "invalid", detail: err };
        next.schedule = { enabled: m.schedule.enabled, timezone: m.schedule.timezone, windows: m.schedule.windows.map((w) => ({ days: [...new Set(w.days)].sort(), start: w.start, end: w.end })) };
        detail = `schedule enabled=${next.schedule.enabled} tz=${next.schedule.timezone} windows=${next.schedule.windows.length}`; break;
      }
      default: return { ok: false, reason: "invalid", detail: "action" };
    }
    next.version = c.version + 1; next.updatedAt = now;
    d.control = next;
    appendAudit(d, actor, m.action, detail, now);
    return { ok: true, control: next };
  });
}

/**
 * Gate for provider calls that are NOT dispatches (e.g. conversational/"converse" calls, monitoring that would call a model).
 * Same decision function as dispatch: GPT-only must never reach Claude/Codex. Callers must abort on !allowed — no fallback.
 */
export async function guardProviderCall(store: RunStore, agent: string, purpose: string, now: string): Promise<GateDecision> {
  return store.transact((d) => {
    const g = evaluateGate(d.control, agent, Date.parse(now));
    if (!g.allowed) { d.blocked[agent] = (d.blocked[agent] ?? 0) + 1; appendAudit(d, "gate", "provider_call_blocked", `${purpose} agent=${agent} reason=${g.reason}`, now); }
    return g;
  });
}

export type CancelResult = { ok: false; reason: "unknown_dispatch" | "not_running" | "provider_cancel_unsupported"; detail: string };
/** Explicit cancellation. No provider integration supports it yet, so this NEVER claims cancellation; the run drains. */
export async function requestCancel(store: RunStore, dispatchId: string, actor: string, now: string): Promise<CancelResult> {
  return store.transact((d): CancelResult => {
    const r = d.records[dispatchId];
    if (!r) return { ok: false, reason: "unknown_dispatch", detail: "no such dispatch" };
    if (isTerminal(r.status) || r.status === "queued") return { ok: false, reason: "not_running", detail: `status=${r.status}` };
    const supported = isAgentKey(r.agent) && CANCEL_SUPPORT[r.agent as AgentKey];
    appendAudit(d, actor, "cancel_requested", `${dispatchId} supported=${supported}`, now);
    return { ok: false, reason: "provider_cancel_unsupported", detail: "provider cancellation is not connected; the run continues (drain) until it finishes or times out" };
  });
}

// ---------- monitoring snapshot (store-only; zero provider calls) ----------
export function buildSnapshot(d: StoreData, nowIso: string) {
  const nowMs = Date.parse(nowIso);
  const recs = Object.values(d.records);
  const agents = AGENT_KEYS.map((key) => {
    const mine = recs.filter((r) => r.agent === key);
    const active = mine.filter((r) => !isTerminal(r.status) && r.status !== "queued");
    const queued = mine.filter((r) => r.status === "queued");
    const last = [...mine].sort((a, b) => (a.lastActivityAt ?? a.requestedAt).localeCompare(b.lastActivityAt ?? b.requestedAt)).pop();
    const gate = evaluateGate(d.control, key, nowMs);
    const ts = (f: "ackAt" | "startedAt" | "lastHeartbeatAt") => mine.map((r) => r[f]).filter(Boolean).sort().pop() ?? null;
    return {
      key, provider: PROVIDER_OF[key], enabled: d.control.agents[key],
      effective: gate.allowed, blockedReason: gate.allowed ? null : gate.reason,
      cancelSupported: CANCEL_SUPPORT[key],
      lastAck: ts("ackAt"), lastRun: ts("startedAt"), lastHeartbeat: ts("lastHeartbeatAt"),
      lastStatus: last ? displayStatus(last) : null,
      running: active.length, queued: queued.length, held: queued.filter((r) => r.held).length,
      // orchestrator consumption only (dispatch counts we issued). Provider usage/cost: unknown unless telemetry exists.
      orchestratorDispatches: mine.length, suppressedByGate: d.blocked[key] ?? 0,
      providerUsage: { state: "unknown", reason: "no provider telemetry connected" } as const,
      externalGate: gateEvidence(d.gateChecks?.[key], nowMs),
    };
  });
  const runs = recs.map((r) => ({ r, trust: runTrust(r) })).map(({ r, trust }) => ({
    dispatchId: r.dispatchId, issueNumber: r.issueNumber, agent: r.agent, attempt: r.attempt, status: displayStatus(r),
    requestedAt: r.requestedAt, ackAt: r.ackAt ?? null, startedAt: r.startedAt ?? null, finishedAt: r.finishedAt ?? null,
    execution: r.execution ?? null,
    verified: trust.verified, origin: trust.origin, trust, held: r.held ?? null, capability: r.capability ?? null,
    lastActivityAt: r.lastActivityAt ?? r.lastHeartbeatAt ?? r.dispatchedAt ?? r.requestedAt,
    lastError: r.lastError ?? null, evidence: r.evidence,
  })).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)).slice(0, 50);
  const lastUpdate = [d.control.updatedAt, ...runs.map((r) => r.lastActivityAt)].filter(Boolean).sort().pop() ?? null;
  return {
    mode: "live" as const, generatedAt: nowIso, lastUpdate,
    control: d.control,
    presets: Object.keys(PRESETS),
    agents, runs,
    errors: runs.filter((r) => r.lastError).slice(0, 10),
    handoffs: runs.filter((r) => r.held || r.dispatchId.includes(">")).slice(0, 20),
    audit: d.audit.slice(-30).reverse(),
    notes: [
      "Orchestrator consumption only; your separate provider usage/quotas are not controlled or measured here.",
      "Provider cost/usage is shown only from supported telemetry (none connected) → unknown.",
      "External GitHub-triggered agents may bypass this gate; only orchestrator dispatch is enforced (see docs/PHASE4.md).",
    ],
  };
}

export { effectiveEnabled };
