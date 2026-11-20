// Claude subscription Routine fire transport ONLY. Inert: no workflow invokes this module.
// Official documentation: https://platform.claude.com/docs/en/api/claude-code/routines-fire
// Not the paid Claude Platform model API; runs count against Claude Code subscription.
const FIRE_URL = /^\/v1\/claude_code\/routines\/(trig_[A-Za-z0-9_-]{8,128})\/fire$/;
const SESSION_URL = /^https:\/\/claude\.ai\/code\/(session_[A-Za-z0-9_-]{8,128})$/;

export function validateRoutineConfig(config) {
  if (!config || typeof config !== "object") return "missing_config";
  let u;
  try { u = new URL(config.url); } catch { return "invalid_url"; }
  if (u.protocol !== "https:" || u.hostname !== "api.anthropic.com" ||
      u.port || u.username || u.password || u.search || u.hash ||
      !FIRE_URL.test(u.pathname)) return "invalid_url";
  if (typeof config.token !== "string" || !config.token.startsWith("sk-ant-oat01-") ||
      config.token.length < 30 || /\s/.test(config.token)) return "invalid_routine_token";
  return null;
}

export function validateRoutineContext(context) {
  if (typeof context !== "string" || context.length === 0 ||
      Buffer.byteLength(context, "utf8") > 65_536) return "invalid_context";
  return null;
}

// Caller MUST verify a genuine persisted authorized dispatch + one-writer lease BEFORE
// invoking this helper, and persist an atomic single-fire reservation before POST.
// This module has no proof of authorization; it cannot enforce caller identity.
// An ambiguous timeout/response is UNKNOWN: NEVER auto-retry, as Anthropic provides
// no idempotency key and each successful POST creates an independent session.
export async function fireRoutine({ config, context, request = fetch }) {
  const cf = validateRoutineConfig(config);
  if (cf) return { ok: false, reason: cf };
  const xf = validateRoutineContext(context);
  if (xf) return { ok: false, reason: xf };
  let response;
  try {
    response = await request(config.url, {
      method: "POST", redirect: "error", cache: "no-store",
      signal: AbortSignal.timeout(10_000),
      headers: {
        authorization: "Bearer " + config.token,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "experimental-cc-routine-2026-04-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({ text: context })
    });
  } catch {
    return { ok: false, reason: "fire_outcome_unknown_DO_NOT_RETRY" };
  }
  // 429 is a subscription/usage limit, NOT a signal to spend credits.
  if (response?.status === 429) return { ok: false, reason: "subscription_limit_NO_OVERAGE" };
  if (response?.status !== 200) return { ok: false, reason: "fire_rejected_or_unknown_DO_NOT_RETRY" };
  let result;
  try { result = await response.json(); }
  catch { return { ok: false, reason: "response_unknown_DO_NOT_RETRY" }; }
  if (result?.type !== "routine_fire" ||
      typeof result.claude_code_session_id !== "string" ||
      !/^session_[A-Za-z0-9_-]{8,128}$/.test(result.claude_code_session_id) ||
      typeof result.claude_code_session_url !== "string" ||
      !SESSION_URL.test(result.claude_code_session_url) ||
      result.claude_code_session_url !== `https://claude.ai/code/${result.claude_code_session_id}`) {
    return { ok: false, reason: "response_mismatch_DO_NOT_RETRY" };
  }
  // HTTP 200 confirms a session was CREATED, not that it checked out the authorized
  // SHA, passed the application gate, claimed a lease, or became a safe writer.
  return {
    ok: true, sessionId: result.claude_code_session_id,
    sessionUrl: result.claude_code_session_url,
    sessionCreated: true, authorizedStartVerified: false
  };
}
