// 영속 단일 사용자 세션 (#85). 무상태 HMAC 서명 쿠키 — 원본 관리자 토큰은 쿠키/클라이언트에 절대 들어가지 않는다.
// - 쿠키 값: base64url(payload JSON) "." base64url(HMAC-SHA256(key, payloadB64))
// - key = HMAC(해당 역할 토큰, "ai-orchestrator/session/v1|" + CONTROL_SESSION_EPOCH). 토큰 교체 또는 EPOCH 변경 = 전체 세션 폐기.
// - 로그아웃은 쿠키 삭제(+Max-Age=0). 서버 측 개별 폐기 목록은 없다(서버리스·무상태) → 분실/탈취 시 EPOCH 를 올려 전체 폐기한다. docs/AUTH.md 참고.
// - 절대 만료 30일(슬라이딩 없음). 로그에 토큰/쿠키 값을 남기지 않는다.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { normalizeToken } from "../control/auth";

export type Role = "admin" | "read";
export type Env = Readonly<Record<string, string | undefined>>;
export interface Session { sid: string; role: Role; iat: number; exp: number }

export const SESSION_TTL_SEC = 30 * 24 * 3600;
const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const eq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export const cookieName = (env: Env) => (env.NODE_ENV === "production" ? "__Host-orch_session" : "orch_session");

function roleSecret(role: Role, env: Env): string | null {
  const t = normalizeToken(role === "admin" ? env.CONTROL_ADMIN_TOKEN : env.CONTROL_READ_TOKEN);
  return t.length >= 16 ? t : null;
}
function key(role: Role, env: Env): Buffer | null {
  const s = roleSecret(role, env);
  return s ? createHmac("sha256", s).update(`ai-orchestrator/session/v1|${env.CONTROL_SESSION_EPOCH ?? ""}`).digest() : null;
}
const sign = (k: Buffer, data: string) => createHmac("sha256", k).update(data).digest("base64url");

/** 이미 검증된 로그인(토큰 확인 완료)에 대해 쿠키 값을 발급한다. */
export function issueSession(role: Role, env: Env, nowMs: number): { value: string; session: Session } | null {
  const k = key(role, env);
  if (!k) return null;
  const session: Session = { sid: b64(randomBytes(16)), role, iat: Math.floor(nowMs / 1000), exp: Math.floor(nowMs / 1000) + SESSION_TTL_SEC };
  const body = b64(JSON.stringify(session));
  return { value: `${body}.${sign(k, body)}`, session };
}

export function verifySession(value: string | null | undefined, env: Env, nowMs: number): Session | null {
  if (!value || value.length > 1024) return null;
  const [body, mac, extra] = value.split(".");
  if (!body || !mac || extra !== undefined) return null;
  let s: Session;
  try { s = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return null; }
  if (!s || (s.role !== "admin" && s.role !== "read") || typeof s.sid !== "string" || !Number.isFinite(s.exp) || !Number.isFinite(s.iat)) return null;
  const k = key(s.role, env);
  if (!k || !eq(sign(k, body), mac)) return null;
  const now = Math.floor(nowMs / 1000);
  if (s.exp <= now || s.iat > now + 60 || s.exp - s.iat > SESSION_TTL_SEC) return null;
  return s;
}

/** CSRF 토큰 = HMAC(sessionKey, "csrf|sid"). 세션에 묶이며 GET /api/session 으로만 전달된다(쿠키 아님, JS 메모리 보관). */
export function csrfToken(s: Session, env: Env): string {
  const k = key(s.role, env);
  return k ? createHmac("sha256", k).update(`csrf|${s.sid}`).digest("base64url") : "";
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function sessionCookie(value: string, env: Env): string {
  const secure = env.NODE_ENV === "production" ? "; Secure" : "";
  return `${cookieName(env)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_SEC}${secure}`;
}
export function clearCookie(env: Env): string {
  const secure = env.NODE_ENV === "production" ? "; Secure" : "";
  return `${cookieName(env)}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}

/** 변경 요청용 CSRF 검증: Origin(있으면)이 요청 호스트와 같아야 하고, x-csrf-token 이 세션과 일치해야 한다. */
export function checkCsrf(h: Headers, s: Session, env: Env, requestUrl?: string): boolean {
  const origin = h.get("origin");
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? (requestUrl ? new URL(requestUrl).host : null);
  if (origin) { try { if (!host || new URL(origin).host !== host) return false; } catch { return false; } }
  else if (h.get("sec-fetch-site") && h.get("sec-fetch-site") !== "same-origin") return false;
  const got = h.get("x-csrf-token");
  const want = csrfToken(s, env);
  return !!got && !!want && eq(got, want);
}
