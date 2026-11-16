// Never echo passwords, hashes, API tokens or cookie values in responses or logs.
import { checkAdmin, checkRead } from "../control/auth";
import { passwordConfigured, verifyPassword } from "./password";
import { LoginLimiter, loginLimiter } from "./rate-limit";
import { BROWSER_SESSION_TTL_SEC, checkCsrf, clearCookie, csrfToken, cookieName, issueSession, readCookie, sameOrigin, sessionCookie, SESSION_TTL_SEC, verifySession, type Env, type Role } from "./session";

export interface SessionReply { status: number; body: unknown; setCookie?: string; retryAfter?: number }
export async function handleSession(method: string, h: Headers, raw: string, env: Env, nowMs: number, limiter: LoginLimiter = loginLimiter): Promise<SessionReply> {
  const s = verifySession(readCookie(h.get("cookie"), cookieName(env)), env, nowMs);
  if (method === "GET") {
    return s
      ? { status: 200, body: { authenticated: true, role: s.role, expiresAt: new Date(s.exp * 1000).toISOString(), csrfToken: csrfToken(s, env) } }
      : { status: 200, body: { authenticated: false } };
  }
  if (!sameOrigin(h, env)) return { status: 403, body: { error: "csrf" } };
  if (method === "DELETE") {
    if (s && !checkCsrf(h, s, env)) return { status: 403, body: { error: "csrf" } };
    return { status: 200, body: { authenticated: false }, setCookie: clearCookie(env) };
  }
  if (method !== "POST") return { status: 405, body: { error: "method_not_allowed" } };
  if (raw.length > 4096) return { status: 413, body: { error: "too_large" } };
  const budget = limiter.take(nowMs);
  if (!budget.allowed) return { status: 429, body: { error: "rate_limited" }, retryAfter: budget.retryAfter };
  let b: Record<string, unknown>;
  try {
    b = JSON.parse(raw);
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error();
  } catch { return { status: 400, body: { error: "bad_request" } }; }
  let role: Role | null = null;
  let remember = false;
  if (typeof b.token === "string" && b.username === undefined && b.password === undefined) {
    // Legacy script clients only. The browser UI never asks for or sends CONTROL_*_TOKEN.
    role = checkAdmin(b.token, env).ok ? "admin" : checkRead(b.token, env).ok ? "read" : null;
    remember = true; // Preserve the existing token-session API contract.
    const check = checkRead(b.token, env);
    if (!role && !check.ok && check.status === 503) return { status: 503, body: { error: "auth_unconfigured" } };
  } else {
    if (!passwordConfigured(env) || !checkAdmin(env.CONTROL_ADMIN_TOKEN ?? "", env).ok) return { status: 503, body: { error: "auth_unconfigured" } };
    if (typeof b.username !== "string" || typeof b.password !== "string" ||
        b.username.length > 256 || b.password.length > 1024 ||
        (b.remember !== undefined && typeof b.remember !== "boolean")) return { status: 400, body: { error: "bad_request" } };
    try { if (await verifyPassword(b.username, b.password, env)) role = "admin"; }
    catch { return { status: 503, body: { error: "auth_unavailable" } }; }
    remember = b.remember === true;
  }
  if (!role) return { status: 401, body: { error: "unauthorized" } };
  const issued = issueSession(role, env, nowMs, remember);
  if (!issued) return { status: 503, body: { error: "auth_unconfigured" } };
  return {
    status: 200,
    body: { authenticated: true, role, expiresAt: new Date(issued.session.exp * 1000).toISOString(), ttlSeconds: remember ? SESSION_TTL_SEC : BROWSER_SESSION_TTL_SEC, csrfToken: csrfToken(issued.session, env) },
    setCookie: sessionCookie(issued.value, env, remember),
  };
}
