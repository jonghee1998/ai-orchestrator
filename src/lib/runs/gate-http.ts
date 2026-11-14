// #34 — transport-independent gate v2 handler (unit-testable without Next).
import { agentSecret, verifyCallback } from "./callback-auth";
import { RunStoreConfigurationError, type RunStore } from "./store";
import { checkExternalGate, parseGateRequest, signGateResponse } from "./external-gate";
import { isAgentKey } from "../control/model";

type Env = Readonly<Record<string, string | undefined>>;
export interface GateHttpResult { status: number; body: string; signature?: string }
const deny = (error: string, status: number): GateHttpResult => ({ status, body: JSON.stringify({ allow: false, error }) });

/**
 * Headers: x-agent-key, x-timestamp, x-event-id, x-signature = HMAC-SHA256(RUN_CALLBACK_SECRET_<AGENT_KEY>, `${ts}.${eventId}.${rawBody}`).
 * Body (signed): {"v":2,"agent":"<x-agent-key>","issueNumber":N[,"dispatchId":"..."]}.
 */
export async function handleGate(h: { get(name: string): string | null }, rawBody: string, getStore: () => RunStore, env: Env, nowMs: number): Promise<GateHttpResult> {
  if (rawBody.length > 4096) return deny("too_large", 413);
  const key = (h.get("x-agent-key") ?? "").toLowerCase();
  if (!isAgentKey(key)) return deny("unauthorized", 401);
  const secret = agentSecret(key, env); // per-agent only: RUN_CALLBACK_SECRET_CLAUDE_OPUS etc.
  const eventId = h.get("x-event-id");
  const auth = verifyCallback({ secret, timestamp: h.get("x-timestamp"), eventId, signature: h.get("x-signature"), rawBody, nowMs });
  if (!auth.ok) return deny("unauthorized", auth.reason === "missing_secret" ? 503 : 401);
  const g = parseGateRequest(rawBody);
  if (!g) return deny("bad_request", 400);
  if (g.agent !== key) return deny("unauthorized", 401); // signed agent must equal the secret's agent
  try {
    const r = await checkExternalGate(getStore(), g, eventId!, new Date(nowMs).toISOString());
    if (!r.ok) return deny(r.reason, r.reason === "replay" ? 409 : 400);
    const body = JSON.stringify({ allow: r.allow, reason: r.reason, agent: r.agent, issueNumber: r.issueNumber, dispatchId: r.dispatchId, at: r.at, eventId: r.eventId });
    return { status: 200, body, signature: signGateResponse(secret!, r.at, r.eventId, body) };
  } catch (e) {
    const cfg = e instanceof RunStoreConfigurationError;
    return deny(cfg ? "store_unconfigured" : "store_error", cfg ? 503 : 500);
  }
}
