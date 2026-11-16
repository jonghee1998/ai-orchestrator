// 통합 인가 (#85): 기존 x-admin-token 헤더 방식(에이전트/스크립트 호환) 우선, 없으면 세션 쿠키.
// 헤더가 있으면 헤더만 평가한다(잘못된 헤더 + 유효 쿠키 = 거부). 쿠키 기반 변경 요청은 CSRF 필수. 헤더 토큰은 ambient 가 아니므로 CSRF 불필요.
import { checkAdmin, checkRead, type AuthReason } from "../control/auth";
import { checkCsrf, cookieName, readCookie, verifySession, type Env } from "./session";

export type Guard = { ok: true; via: "token" | "session" } | { ok: false; status: 401 | 403 | 503; reason?: AuthReason | "csrf" | "insufficient_role" };
const isMutation = (m: string) => !["GET", "HEAD", "OPTIONS"].includes(m.toUpperCase());

export function authorize(method: string, h: Headers, level: "read" | "admin", env: Env = process.env, nowMs = Date.now()): Guard {
  const header = h.get("x-admin-token");
  if (header !== null) {
    const a = level === "admin" ? checkAdmin(header, env) : checkRead(header, env);
    return a.ok ? { ok: true, via: "token" } : a;
  }
  const s = verifySession(readCookie(h.get("cookie"), cookieName(env)), env, nowMs);
  if (s) {
    if (level === "admin" && s.role !== "admin") return { ok: false, status: 403, reason: "insufficient_role" };
    if (isMutation(method) && !checkCsrf(h, s, env)) return { ok: false, status: 403, reason: "csrf" };
    return { ok: true, via: "session" };
  }
  const none = level === "admin" ? checkAdmin(null, env) : checkRead(null, env);
  return none.ok ? { ok: false, status: 401, reason: "token_missing" } : none;
}
