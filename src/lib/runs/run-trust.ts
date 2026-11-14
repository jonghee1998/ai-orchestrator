// #57 (PR56 P2 r4575905119): one evidence model for every read API and UI, so a session self-report is never shown as
// a verified run. Pure (no node imports): shared by /api/runs, the control/dashboard snapshot and the client views.
//
//  receipt    who delivered the run's signals and how they were authenticated:
//               hmac_signed     per-agent HMAC (subscription runner, or the pre-#55 legacy callback)
//               session_header  proxy-injected per-agent session header: proves the request came from that agent's
//                               environment, NOT what the session actually executed
//               none            nothing received from an agent
//  execution  runner_reported | session_self_report_unverified | none  (tests/summary/exit code as reported)
//  cleanup    runner_attested (signed process-group-empty proof) | unproven | not_applicable (never claimed)
//  verified   true ONLY for an HMAC receipt from a runner-origin run. Never true for a session, and it never means the
//             outcome, tests or stop were independently verified (no claim of an independently verified result).
import { displayStatus, latencies, type DispatchRecord } from "./run-tracking";

export interface RunTrust {
  origin: "runner" | "session" | null;
  receipt: "hmac_signed" | "session_header" | "none";
  execution: "runner_reported" | "session_self_report_unverified" | "none";
  cleanup: "runner_attested" | "unproven" | "not_applicable";
  verified: boolean;
}

export function runTrust(r: DispatchRecord): RunTrust {
  // Any session marker wins (fail closed for partial/legacy PR56-era records).
  const session = r.runOrigin === "session" || r.source === "session-self-report" || r.execution?.attestation === "external_session_self_report";
  const claimed = !!r.runId || r.source !== "none";
  const origin = session ? "session" : claimed ? "runner" : null;
  const receipt = session ? "session_header" : r.source === "agent-callback" ? "hmac_signed" : "none";
  const execution = !r.execution ? "none" : session ? "session_self_report_unverified" : "runner_reported";
  const proven = !session && (r.execution?.cleanup?.processGroupsEmpty === true || (!!r.runId && r.quiescence?.runId === r.runId));
  const cleanup = origin === null ? "not_applicable" : proven ? "runner_attested" : "unproven";
  return { origin, receipt, execution, cleanup, verified: receipt === "hmac_signed" && origin === "runner" };
}

/** GET /api/runs row. `verified` is derived from trust (kept for older clients) — never from `source` alone. */
export function runView(r: DispatchRecord) {
  const trust = runTrust(r);
  return {
    dispatchId: r.dispatchId, issueNumber: r.issueNumber, agent: r.agent, attempt: r.attempt,
    status: displayStatus(r), verified: trust.verified, origin: trust.origin, trust, submission: r.submission ?? null,
    lastActivityAt: r.lastActivityAt ?? r.lastHeartbeatAt ?? r.dispatchedAt ?? r.requestedAt,
    lastError: r.lastError ?? null, evidence: r.evidence, latency: latencies(r),
    collaboration: r.collaboration ?? null, execution: r.execution ?? null,
  };
}

const ONE = <T extends string>(v: unknown, allowed: readonly T[]): v is T => typeof v === "string" && (allowed as readonly string[]).includes(v);
/** Client-side validation of an API trust object. Anything malformed => null (rendered as unknown, never verified). */
export function parseTrust(v: unknown): RunTrust | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const t = v as Record<string, unknown>;
  if (!(t.origin === null || ONE(t.origin, ["runner", "session"] as const)) || !ONE(t.receipt, ["hmac_signed", "session_header", "none"] as const) ||
      !ONE(t.execution, ["runner_reported", "session_self_report_unverified", "none"] as const) ||
      !ONE(t.cleanup, ["runner_attested", "unproven", "not_applicable"] as const) || typeof t.verified !== "boolean") return null;
  const origin = t.origin as RunTrust["origin"];
  // Re-derive `verified` instead of trusting the flag: only an HMAC receipt on a runner-origin run qualifies.
  const session = origin === "session" || t.receipt === "session_header" || t.execution === "session_self_report_unverified";
  return { origin: session ? "session" : origin, receipt: session ? "session_header" : t.receipt as RunTrust["receipt"],
    execution: t.execution as RunTrust["execution"], cleanup: session && t.cleanup === "runner_attested" ? "unproven" : t.cleanup as RunTrust["cleanup"],
    verified: !session && t.verified === true && t.receipt === "hmac_signed" && origin === "runner" };
}

/** Evidence label used by RunsPanel, the progress view and the control/overview run lists. */
export function trustLabel(t: RunTrust | null | undefined, status: string): { verified: boolean; text: string } {
  if (status === "unknown") return { verified: false, text: "수신 미확인" };
  if (!t) return { verified: false, text: "검증 근거 미상 (trust 정보 없음)" };
  if (t.origin === "session") {
    const exec = t.execution === "session_self_report_unverified" ? "실행·테스트 결과는 세션 자기보고(미검증)" : "실행 결과 미보고(미검증)";
    return { verified: false, text: `세션 수신만 인증 · ${exec} · 정리 증명 없음` };
  }
  if (t.verified) return { verified: true, text: `agent 확인 (HMAC 서명) · ${t.cleanup === "runner_attested" ? "runner 정리 증명" : "정리 미증명"}` };
  return { verified: false, text: "미검증 — agent 수신 없음" };
}
