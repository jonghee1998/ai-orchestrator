// Agent callback authentication: HMAC-SHA256 over `${timestamp}.${eventId}.${rawBody}`.
// Secrets are server-only (env), never logged or returned.
import { createHmac, timingSafeEqual } from "node:crypto";

export const MAX_SKEW_MS = 5 * 60_000;

export function signCallback(secret: string, timestamp: string, eventId: string, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${eventId}.${rawBody}`).digest("hex");
}

export type AuthResult = { ok: true } | { ok: false; reason: "missing_secret" | "bad_timestamp" | "skew" | "bad_signature" | "bad_event_id" };

export function verifyCallback(opts: {
  secret: string | undefined; timestamp: string | null; eventId: string | null;
  signature: string | null; rawBody: string; nowMs: number; maxSkewMs?: number;
}): AuthResult {
  if (!opts.secret) return { ok: false, reason: "missing_secret" }; // fail closed
  if (!opts.eventId || !/^[A-Za-z0-9._-]{8,128}$/.test(opts.eventId)) return { ok: false, reason: "bad_event_id" };
  if (!opts.timestamp || !/^\d{10,13}$/.test(opts.timestamp)) return { ok: false, reason: "bad_timestamp" };
  const ts = opts.timestamp.length <= 10 ? Number(opts.timestamp) * 1000 : Number(opts.timestamp);
  if (Math.abs(opts.nowMs - ts) > (opts.maxSkewMs ?? MAX_SKEW_MS)) return { ok: false, reason: "skew" };
  const expected = Buffer.from(signCallback(opts.secret, opts.timestamp, opts.eventId, opts.rawBody), "hex");
  let given: Buffer;
  try { given = Buffer.from(opts.signature ?? "", "hex"); } catch { return { ok: false, reason: "bad_signature" }; }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "bad_signature" };
  return { ok: true };
}

/** Per-agent secret: RUN_CALLBACK_SECRET_<AGENT> (e.g. RUN_CALLBACK_SECRET_CLAUDE). */
export function agentSecret(agent: string, env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  if (!/^[a-z0-9-]{1,32}$/.test(agent)) return undefined;
  return env[`RUN_CALLBACK_SECRET_${agent.toUpperCase().replace(/-/g, "_")}`] || undefined;
}
