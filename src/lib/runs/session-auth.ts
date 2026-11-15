// #55 — authentication for provider routine SESSIONS (Claude Code cloud routines) that cannot hold an HMAC key.
//
// Trust model (read docs/SESSION_AUTH.md):
//  - The owner configures a Claude "Network Secret": the egress proxy of ONE agent's cloud environment injects a static
//    header `x-orch-session-token: <token>` on requests to the orchestrator host. The model/process never reads the
//    value, and it is not an environment variable.
//  - The server stores ONLY sha256(token) per agent: SESSION_TOKEN_SHA256_CLAUDE_SONNET / _CLAUDE_OPUS. The token is a
//    dedicated credential: it is refused (503) if it equals any HMAC secret, admin/read/cron token, or another agent's.
//  - A static header is a bearer credential, NOT a signature: it proves "a request left that agent's environment", not
//    what the body says. Integrity of the body relies on TLS; replay is bounded by a one-time x-event-id (stored in the
//    same durable `events` table as HMAC events) plus a 5 minute x-timestamp window; task binding (agent, issue,
//    dispatchId, runId, targetSha) is enforced server side against the durable record.
//  - This channel can NEVER attest process cleanup/quiescence. It is accepted only on /api/collaboration/session; the
//    existing HMAC endpoints (/api/gate, /api/collaboration/worker, /api/runs/callback) ignore the header entirely.
import { createHash, timingSafeEqual } from "node:crypto";
import { MAX_SKEW_MS, agentSecret } from "./callback-auth";
import { normalizeToken } from "../control/auth";

type Env = Readonly<Record<string, string | undefined>>;
export const SESSION_HEADER = "x-orch-session-token";
/** Only Claude routine sessions use this channel. Codex keeps its HMAC runner; GPT never executes. */
export const SESSION_AGENTS = ["claude-sonnet", "claude-opus"] as const;
export type SessionAgent = (typeof SESSION_AGENTS)[number];
export const isSessionAgent = (s: unknown): s is SessionAgent => typeof s === "string" && (SESSION_AGENTS as readonly string[]).includes(s);

const envKey = (agent: string) => `SESSION_TOKEN_SHA256_${agent.toUpperCase().replace(/-/g, "_")}`;
const sha = (s: string) => createHash("sha256").update(s).digest();
const hexHash = (v: string | undefined) => { const t = (v ?? "").trim().toLowerCase(); return /^[a-f0-9]{64}$/.test(t) ? Buffer.from(t, "hex") : null; };

export type SessionAuth =
  | { ok: true; agent: SessionAgent }
  | { ok: false; status: 401 | 503; reason: "not_configured" | "misconfigured" | "bad_token" | "bad_agent" | "bad_event_id" | "bad_timestamp" | "skew" };

/**
 * Fail-closed configuration check for one agent. misconfigured => the token hash collides with a credential of another
 * trust domain, so accepting it would let one leak escalate into another channel.
 */
function configured(agent: SessionAgent, env: Env): Buffer | "missing" | "misconfigured" {
  const want = hexHash(env[envKey(agent)]);
  if (!want) return "missing";
  for (const other of SESSION_AGENTS) if (other !== agent) { const o = hexHash(env[envKey(other)]); if (o && o.equals(want)) return "misconfigured"; }
  const foreign = [
    ...["gpt", "claude-sonnet", "claude-opus", "codex"].map(a => agentSecret(a, env)),
    env.CONTROL_ADMIN_TOKEN, env.CONTROL_READ_TOKEN, env.CRON_SECRET, env.GITHUB_TOKEN, env.GITHUB_READ_TOKEN,
  ].map(v => normalizeToken(v)).filter(Boolean);
  if (foreign.some(v => sha(v).equals(want) || v.toLowerCase() === want.toString("hex"))) return "misconfigured";
  return want;
}

export function verifySession(h: { get(name: string): string | null }, env: Env, nowMs: number): SessionAuth {
  const agent = (h.get("x-agent-key") ?? "").trim();
  if (!isSessionAgent(agent)) return { ok: false, status: 401, reason: "bad_agent" };
  const want = configured(agent, env);
  if (want === "missing") return { ok: false, status: 503, reason: "not_configured" };
  if (want === "misconfigured") return { ok: false, status: 503, reason: "misconfigured" };
  const token = normalizeToken(h.get(SESSION_HEADER));
  // A dedicated high-entropy credential: short values are refused rather than compared.
  if (token.length < 32 || token.length > 512 || !timingSafeEqual(sha(token), want)) return { ok: false, status: 401, reason: "bad_token" };
  const eventId = h.get("x-event-id");
  if (!eventId || !/^[A-Za-z0-9._-]{8,128}$/.test(eventId)) return { ok: false, status: 401, reason: "bad_event_id" };
  const ts = h.get("x-timestamp");
  if (!ts || !/^\d{10,13}$/.test(ts)) return { ok: false, status: 401, reason: "bad_timestamp" };
  const tsMs = ts.length <= 10 ? Number(ts) * 1000 : Number(ts);
  if (Math.abs(nowMs - tsMs) > MAX_SKEW_MS) return { ok: false, status: 401, reason: "skew" };
  return { ok: true, agent };
}

/** For readiness/diagnostics only: configured | missing | misconfigured. Never returns hashes or tokens. */
export function sessionAuthState(agent: SessionAgent, env: Env): "configured" | "missing" | "misconfigured" {
  const c = configured(agent, env);
  return Buffer.isBuffer(c) ? "configured" : c;
}
