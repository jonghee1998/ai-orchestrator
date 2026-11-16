// /api/session 핸들러 (#85) — 순수 함수로 두어 단위 테스트한다. 어떤 경로로도 토큰/쿠키 값을 로그·응답에 에코하지 않는다.
import { checkAdmin, checkRead } from "../control/auth";
import { clearCookie, csrfToken, cookieName, issueSession, readCookie, sessionCookie, SESSION_TTL_SEC, verifySession, type Env } from "./session";

export interface SessionReply { status: number; body: unknown; setCookie?: string }
const sameOrigin = (h: Headers) => {
  const origin = h.get("origin");
  if (!origin) return h.get("sec-fetch-site") === null || h.get("sec-fetch-site") === "same-origin";
  try { return new URL(origin).host === (h.get("x-forwarded-host") ?? h.get("host")); } catch { return false; }
};

export function handleSession(method: string, h: Headers, raw: string, env: Env, nowMs: number): SessionReply {
  if (method === "GET") {
    const s = verifySession(readCookie(h.get("cookie"), cookieName(env)), env, nowMs);
    return s
      ? { status: 200, body: { authenticated: true, role: s.role, expiresAt: new Date(s.exp * 1000).toISOString(), csrfToken: csrfToken(s, env) } }
      : { status: 200, body: { authenticated: false } };
  }
  if (!sameOrigin(h)) return { status: 403, body: { error: "csrf" } }; // 로그인/로그아웃 CSRF 방어
  if (method === "DELETE") return { status: 200, body: { authenticated: false }, setCookie: clearCookie(env) };
  if (method !== "POST") return { status: 405, body: { error: "method_not_allowed" } };
  if (raw.length > 4096) return { status: 413, body: { error: "too_large" } };
  let token = "";
  try { const b = JSON.parse(raw); if (b && typeof b.token === "string") token = b.token; } catch { return { status: 400, body: { error: "bad_request" } }; }
  // 기존 토큰으로 한 번 인증 → 관리자 토큰이면 admin 세션, 읽기 토큰이면 read 세션. 토큰 자체는 저장/반환하지 않는다.
  const admin = checkAdmin(token, env);
  const role = admin.ok ? "admin" : checkRead(token, env).ok ? "read" : null;
  if (!role) {
    const r = checkRead(token, env);
    return !r.ok && r.status === 503 ? { status: 503, body: { error: "auth_unconfigured" } } : { status: 401, body: { error: "unauthorized" } };
  }
  const issued = issueSession(role, env, nowMs);
  if (!issued) return { status: 503, body: { error: "auth_unconfigured" } };
  return {
    status: 200,
    body: { authenticated: true, role, expiresAt: new Date(issued.session.exp * 1000).toISOString(), ttlSeconds: SESSION_TTL_SEC, csrfToken: csrfToken(issued.session, env) },
    setCookie: sessionCookie(issued.value, env),
  };
}
