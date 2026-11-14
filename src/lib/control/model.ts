// Phase 4 — agent control plane model (pure; no I/O, no provider calls).
//
// Fail-closed: the default state has every agent paused. A dispatch is allowed only when
// the agent is explicitly enabled (and its provider switch is on, and any enabled schedule
// window is open). Unknown agent keys are always blocked.

export const AGENT_KEYS = ["gpt", "claude-sonnet", "claude-opus", "codex"] as const;
export type AgentKey = (typeof AGENT_KEYS)[number];
export const isAgentKey = (s: unknown): s is AgentKey => typeof s === "string" && (AGENT_KEYS as readonly string[]).includes(s);

export type Provider = "openai" | "anthropic";
export const PROVIDER_OF: Record<AgentKey, Provider> = {
  gpt: "openai", codex: "openai", "claude-sonnet": "anthropic", "claude-opus": "anthropic",
};

export type Capability = "pm" | "develop" | "review" | "converse";
export const CAPABILITIES: Capability[] = ["pm", "develop", "review", "converse"];
/** Static capability table: what each agent may legitimately do. Reroute never crosses this. */
export const AGENT_CAPS: Record<AgentKey, Capability[]> = {
  gpt: ["pm", "review", "converse"],
  codex: ["develop", "review"],
  "claude-sonnet": ["develop", "review", "converse"],
  "claude-opus": ["develop", "review", "converse"],
};
/** No provider integration supports cancellation yet; UI must not claim otherwise. */
export const CANCEL_SUPPORT: Record<AgentKey, boolean> = { gpt: false, codex: false, "claude-sonnet": false, "claude-opus": false };

export interface ScheduleWindow { days: number[]; start: string; end: string } // days 0=Sun..6=Sat, HH:MM local to timezone
export interface Schedule { enabled: boolean; timezone: string; windows: ScheduleWindow[] }

export interface ControlState {
  version: number;
  updatedAt: string | null;
  agents: Record<AgentKey, boolean>;
  /** Provider-wide Claude switch: false disables both Claude models regardless of per-agent flag. */
  claudeProvider: boolean;
  preset: PresetName | "custom";
  /** Ordered routing preference per capability. Only enabled agents are ever chosen. */
  routing: Record<Capability, AgentKey[]>;
  /** Queued-but-unsent work is rerouted only if true; otherwise it is held. */
  allowReroute: boolean;
  schedule: Schedule;
}

export type PresetName = "gpt-only" | "claude-only" | "all-enabled" | "all-paused";
export const PRESETS: Record<PresetName, { agents: Record<AgentKey, boolean>; claudeProvider: boolean }> = {
  "gpt-only": { agents: { gpt: true, codex: false, "claude-sonnet": false, "claude-opus": false }, claudeProvider: false },
  "claude-only": { agents: { gpt: false, codex: false, "claude-sonnet": true, "claude-opus": true }, claudeProvider: true },
  "all-enabled": { agents: { gpt: true, codex: true, "claude-sonnet": true, "claude-opus": true }, claudeProvider: true },
  "all-paused": { agents: { gpt: false, codex: false, "claude-sonnet": false, "claude-opus": false }, claudeProvider: false },
};

export const defaultControl = (): ControlState => ({
  version: 0, updatedAt: null,
  agents: { ...PRESETS["all-paused"].agents }, claudeProvider: false, preset: "all-paused",
  routing: { pm: ["gpt"], develop: ["claude-sonnet", "claude-opus", "codex"], review: ["claude-sonnet", "claude-opus", "gpt", "codex"], converse: ["gpt", "claude-sonnet", "claude-opus"] },
  allowReroute: false,
  schedule: { enabled: false, timezone: "Asia/Seoul", windows: [] }, // no default schedule is active
});

export function validTimezone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export function validateSchedule(s: Schedule): string | null {
  if (typeof s.enabled !== "boolean" || typeof s.timezone !== "string" || !validTimezone(s.timezone)) return "invalid timezone";
  if (!Array.isArray(s.windows) || s.windows.length > 14) return "invalid windows";
  for (const w of s.windows) {
    if (!Array.isArray(w.days) || w.days.length === 0 || w.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return "invalid days";
    if (!HHMM.test(w.start) || !HHMM.test(w.end) || w.start >= w.end) return "invalid time range";
  }
  return null;
}

/** Is `nowMs` inside an allowed window? Always true when the schedule is disabled. */
export function scheduleOpen(s: Schedule, nowMs: number): boolean {
  if (!s.enabled) return true;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: s.timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(nowMs));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  const hm = `${get("hour")}:${get("minute")}`;
  return s.windows.some((w) => w.days.includes(day) && hm >= w.start && hm < w.end);
}

export type GateReason = "unknown_agent" | "agent_disabled" | "provider_disabled" | "outside_schedule";
export type GateDecision = { allowed: true } | { allowed: false; reason: GateReason };

/** THE dispatch gate. Must be evaluated inside the same store transaction that records the dispatch. */
export function evaluateGate(c: ControlState, agent: string, nowMs: number): GateDecision {
  if (!isAgentKey(agent)) return { allowed: false, reason: "unknown_agent" };
  if (!c.agents[agent]) return { allowed: false, reason: "agent_disabled" };
  if (PROVIDER_OF[agent] === "anthropic" && !c.claudeProvider) return { allowed: false, reason: "provider_disabled" };
  if (!scheduleOpen(c.schedule, nowMs)) return { allowed: false, reason: "outside_schedule" };
  return { allowed: true };
}
export const effectiveEnabled = (c: ControlState, agent: AgentKey, nowMs: number): boolean => evaluateGate(c, agent, nowMs).allowed;

/** First enabled agent for a capability, or null (=> hold). Never returns a disabled agent. */
export function routeTarget(c: ControlState, cap: Capability, nowMs: number, exclude?: AgentKey): AgentKey | null {
  for (const a of c.routing[cap] ?? []) if (a !== exclude && AGENT_CAPS[a].includes(cap) && effectiveEnabled(c, a, nowMs)) return a;
  return null;
}

export interface AuditEntry { at: string; actor: string; action: string; detail: string; version: number }
