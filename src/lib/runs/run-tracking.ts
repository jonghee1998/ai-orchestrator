// Phase 3 — dispatch/run tracking (pure, deterministic; no provider calls).
//
// 원칙: provider 실행 상태는 검증 가능한 신호(agent ACK/heartbeat 콜백, GitHub 증거)로만 갱신한다.
// 신호가 없으면 상태를 추정하지 않고 "unknown"/"timeout" 으로 표시한다.

export type RunStatus =
  | "queued"
  | "dispatched"
  | "acknowledged"
  | "running"
  | "succeeded"
  | "failed"
  | "timeout"
  | "unknown";

export type EvidenceKind = "pr" | "commit" | "test" | "comment" | "other";
export interface Evidence { kind: EvidenceKind; url: string; at: string }

export interface DispatchRecord {
  collaboration?: { workflowId: string; cycle: number; step: "claude" | "codex"; repo: string; baseBranch: string; baseSha: string; workBranch: string; targetSha: string; prNumber?: number; instructions: string };
  /** `cleanup` is the runner's signed proof that every process group of the run was empty (#49); required for new results. */
  execution?: { exitCode: number; summary: string; headSha: string; tests: { command: string; exitCode: number }[]; cleanup?: { processGroupsEmpty: true; groups: number };
    /** #55: set for session-origin results; marks tests/summary as unverified self-report (never cleanup proof). */
    attestation?: "external_session_self_report" };
  /** #55: channel that claimed runId. Absent = "runner" (HMAC subscription-worker; all records before #55). */
  runOrigin?: "runner" | "session";
  dispatchId: string;
  issueNumber: number;
  agent: string;
  status: RunStatus;
  requestedAt: string;
  dispatchedAt?: string;
  ackAt?: string;
  runId?: string;
  startedAt?: string;
  lastHeartbeatAt?: string;
  finishedAt?: string;
  attempt: number;
  lastError?: string;
  evidence: Evidence[];
  /** 상태 근거: agent 콜백만 "verified". 그 외는 추정 금지. */
  source: "none" | "agent-callback";
  /** provider submission outcome; "unknown" = possible lost ACK (never auto-retried) */
  submission?: "accepted" | "rejected_not_accepted" | "unknown";
  lastActivityAt?: string;
  /** Phase 4: capability the work needs (drives reroute eligibility) */
  capability?: string;
  /** Phase 4: set when the gate blocked the provider call; no provider call was made. Cleared on release. */
  held?: string;
  /** #34: set when authorizeSubmission let this record through the gate (before the provider/label call). */
  submitAuthorizedAt?: string;
  /**
   * #41 P1: signed runner attestation that the claimed CLI's whole process group exited (killed after lease
   * revocation/expiry or reaped after normal exit). Only this, a structured execution result, or "never claimed"
   * proves the old run can no longer write; a terminal status alone does not.
   */
  quiescence?: { at: string; runId: string; reason: "lease_revoked" | "lease_expired" | "cleanup_retry"; signal: string | null };
  /** #49: runner reported it could NOT prove its process groups empty. Diagnostic only; never counts as quiescence. */
  cleanupFailure?: { at: string; runId: string; reason: "lease_revoked" | "lease_expired" | "normal_exit"; groups: number; unproven: number };
}

export interface Timeouts { ackMs: number; heartbeatMs: number }
export const DEFAULT_TIMEOUTS: Timeouts = { ackMs: 5 * 60_000, heartbeatMs: 15 * 60_000 };

const TERMINAL: RunStatus[] = ["succeeded", "failed", "timeout"];
export const isTerminal = (s: RunStatus): boolean => TERMINAL.includes(s);

export type RunEvent =
  | { type: "dispatched"; at: string }
  | { type: "ack"; at: string; runId: string }
  | { type: "started"; at: string; runId: string }
  | { type: "heartbeat"; at: string; runId: string }
  | { type: "finished"; at: string; runId: string; ok: boolean; error?: string; evidence?: Evidence[] };

export function dispatchIdFor(issueNumber: number, agent: string, attempt: number): string {
  return `d-${issueNumber}-${agent}-${attempt}`;
}

export function createDispatch(issueNumber: number, agent: string, now: string, attempt = 1): DispatchRecord {
  return {
    dispatchId: dispatchIdFor(issueNumber, agent, attempt),
    issueNumber, agent, status: "queued", requestedAt: now, attempt, evidence: [], source: "none",
  };
}

/** Pure reducer. 잘못된 순서/중복/다른 runId 이벤트는 무시(상태 불변)하고 그대로 반환한다. */
export function applyEvent(rec: DispatchRecord, ev: RunEvent): DispatchRecord {
  if (isTerminal(rec.status)) return rec;
  const sameRun = (id: string) => rec.runId === undefined || rec.runId === id;
  switch (ev.type) {
    case "dispatched":
      return rec.status === "queued" ? { ...rec, status: "dispatched", dispatchedAt: ev.at } : rec;
    case "ack":
      if (rec.status !== "dispatched") return rec; // 중복 ACK 무시
      return { ...rec, status: "acknowledged", ackAt: ev.at, runId: ev.runId, source: "agent-callback" };
    case "started":
      if (!["dispatched", "acknowledged"].includes(rec.status) || !sameRun(ev.runId)) return rec;
      return { ...rec, status: "running", runId: ev.runId, ackAt: rec.ackAt ?? ev.at, startedAt: ev.at, lastHeartbeatAt: ev.at, source: "agent-callback" };
    case "heartbeat":
      if (rec.status !== "running" || !sameRun(ev.runId)) return rec;
      return { ...rec, lastHeartbeatAt: ev.at };
    case "finished":
      if (!sameRun(ev.runId) || rec.runId === undefined) return rec;
      return {
        ...rec, status: ev.ok ? "succeeded" : "failed", finishedAt: ev.at,
        lastError: ev.ok ? undefined : ev.error ?? "failed (no detail)",
        evidence: [...rec.evidence, ...(ev.evidence ?? [])],
      };
  }
}

/** 시간 경과 판정: ACK/heartbeat 미수신은 timeout. (실행 중이라고 추정하지 않는다) */
export function evaluateTimeout(rec: DispatchRecord, now: string, t: Timeouts = DEFAULT_TIMEOUTS): DispatchRecord {
  if (isTerminal(rec.status)) return rec;
  const n = Date.parse(now);
  if (rec.status === "dispatched" && rec.dispatchedAt && n - Date.parse(rec.dispatchedAt) > t.ackMs) {
    return { ...rec, status: "timeout", finishedAt: now, lastError: "ACK timeout" };
  }
  if ((rec.status === "acknowledged" || rec.status === "running") && n - Date.parse(rec.lastHeartbeatAt ?? rec.ackAt ?? now) > t.heartbeatMs) {
    return { ...rec, status: "timeout", finishedAt: now, lastError: "heartbeat timeout" };
  }
  return rec;
}

/** 명시적 재시도: failed/timeout 만 가능, 활성 dispatch 가 있으면 중복 방지로 거부. */
export function retryDispatch(records: DispatchRecord[], issueNumber: number, agent: string, now: string):
  { ok: true; record: DispatchRecord } | { ok: false; reason: "active_dispatch_exists" | "not_retryable" } {
  const mine = records.filter((r) => r.issueNumber === issueNumber && r.agent === agent);
  if (mine.some((r) => !isTerminal(r.status))) return { ok: false, reason: "active_dispatch_exists" };
  if (mine.some((r) => r.status === "succeeded")) return { ok: false, reason: "not_retryable" };
  return { ok: true, record: createDispatch(issueNumber, agent, now, mine.length + 1) };
}

/** 최초 dispatch 중복 방지 */
export function requestDispatch(records: DispatchRecord[], issueNumber: number, agent: string, now: string):
  { ok: true; record: DispatchRecord } | { ok: false; reason: "already_exists" } {
  if (records.some((r) => r.issueNumber === issueNumber && r.agent === agent)) return { ok: false, reason: "already_exists" };
  return { ok: true, record: createDispatch(issueNumber, agent, now) };
}

/** 표시용 상태: 신호가 없는 dispatched 는 "unknown"(수신 여부 미확인)으로 보여준다. */
export function displayStatus(rec: DispatchRecord): RunStatus {
  return rec.status === "dispatched" ? "unknown" : rec.status;
}

/** 이벤트 지연(ms) 측정: 요청→ACK, ACK→시작 */
export function latencies(rec: DispatchRecord): { ackMs?: number; startMs?: number } {
  const d = (a?: string, b?: string) => (a && b ? Date.parse(b) - Date.parse(a) : undefined);
  return { ackMs: d(rec.dispatchedAt, rec.ackAt), startMs: d(rec.ackAt, rec.startedAt) };
}
