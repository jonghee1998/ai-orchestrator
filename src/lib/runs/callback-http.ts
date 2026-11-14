// Legacy per-agent HMAC run callback (POST /api/runs/callback), extracted from the route so the signed request path is
// testable (#57). Behaviour and security checks are unchanged: per-agent secret (no fallback), generic 401/503, signed
// timestamp/event id/body, replay-idempotent apply. New: session-origin runs are refused with 409 origin_mismatch.
import { agentSecret, verifyCallback } from "./callback-auth";
import { RunStoreConfigurationError, type RunStore } from "./store";
import { applyCallback } from "./service";
import type { RunEvent } from "./run-tracking";

export interface CallbackReply { status: number; body: string }
const json = (status: number, data: unknown): CallbackReply => ({ status, body: JSON.stringify(data) });

export async function handleRunCallback(headers: Headers, rawBody: string, store: () => RunStore,
  env: Readonly<Record<string, string | undefined>>, nowMs: number): Promise<CallbackReply> {
  if (rawBody.length > 64 * 1024) return json(413, { error: "too_large" });
  const agent = (headers.get("x-agent") ?? "").toLowerCase();
  const auth = verifyCallback({
    secret: agentSecret(agent, env), timestamp: headers.get("x-timestamp"), eventId: headers.get("x-event-id"),
    signature: headers.get("x-signature"), rawBody, nowMs,
  });
  // Generic 401/503: never reveal which check failed or secret state to callers.
  if (!auth.ok) return json(auth.reason === "missing_secret" ? 503 : 401, { error: "unauthorized" });
  let b: Record<string, unknown>;
  try { b = JSON.parse(rawBody); } catch { return json(400, { error: "bad_request" }); }
  if (!b || typeof b !== "object") return json(400, { error: "bad_request" });
  const at = new Date(nowMs).toISOString();
  const dispatchId = String(b.dispatchId ?? ""), runId = String(b.runId ?? "");
  const type = b.type;
  if (!dispatchId || !runId || !["ack", "started", "heartbeat", "finished"].includes(String(type))) return json(400, { error: "bad_request" });
  const ev = (type === "finished"
    ? { type, at, runId, ok: b.ok === true, error: typeof b.error === "string" ? b.error.slice(0, 500) : undefined }
    : { type, at, runId }) as RunEvent;
  try {
    const r = await applyCallback(store(), headers.get("x-event-id")!, dispatchId, agent, ev, at);
    if (!r.ok) return json(r.reason === "origin_mismatch" ? 409 : 404, { error: r.reason });
    return json(200, { ok: true, duplicate: r.duplicate });
  } catch (e) {
    const cfg = e instanceof RunStoreConfigurationError;
    return json(cfg ? 503 : 500, { error: cfg ? "store_unconfigured" : "store_error" });
  }
}
