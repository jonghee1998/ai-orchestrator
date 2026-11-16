"use client";
// 브라우저 세션 스토어 (#85). 원본 토큰은 어디에도 저장하지 않는다(localStorage/sessionStorage/쿠키 JS 접근 없음).
// 로그인 시 토큰은 POST /api/session 로 한 번만 전송되고, 이후에는 서버가 발급한 HttpOnly 쿠키가 인증한다.
// CSRF 토큰은 메모리에만 보관하며 변경 요청의 x-csrf-token 헤더로 보낸다.
import { useSyncExternalStore } from "react";
import { SESSION_MARK } from "@/lib/session/client";

export type SessionState = { status: "unknown" | "anon" | "authed"; role: "admin" | "read" | null; csrf: string; expiresAt: string | null; version: number };
let st: SessionState = { status: "unknown", role: null, csrf: "", expiresAt: null, version: 0 };
const subs = new Set<() => void>();
const set = (p: Partial<SessionState>) => { st = { ...st, ...p, version: st.version + 1 }; subs.forEach((f) => f()); };
const apply = (j: any) => j?.authenticated ? set({ status: "authed", role: j.role, csrf: String(j.csrfToken ?? ""), expiresAt: j.expiresAt ?? null }) : set({ status: "anon", role: null, csrf: "", expiresAt: null });

export const getSession = () => st;
export const readToken = () => (st.status === "authed" ? SESSION_MARK : "");
export const csrfHeaders = (): Record<string, string> => (st.csrf ? { "x-csrf-token": st.csrf } : {});

export async function loadSession(): Promise<void> {
  try { const r = await fetch("/api/session", { cache: "no-store" }); apply(await r.json().catch(() => null)); }
  catch { if (st.status === "unknown") set({ status: "anon" }); }
}
export async function login(token: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const r = await fetch("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    const j = await r.json().catch(() => null);
    if (r.ok && j?.authenticated) { apply(j); return { ok: true }; }
    return { ok: false, message: r.status === 503 ? "서버 인증이 설정되지 않았습니다 (CONTROL_*_TOKEN)." : r.status === 401 ? "토큰이 올바르지 않습니다 (401)." : `로그인 실패 (${r.status})` };
  } catch { return { ok: false, message: "네트워크 오류" }; }
}
export async function logout(): Promise<void> {
  try { await fetch("/api/session", { method: "DELETE" }); } catch { /* 서버 도달 실패 시에도 로컬 상태는 해제 */ }
  set({ status: "anon", role: null, csrf: "", expiresAt: null });
}
/** API 가 세션 만료(401)를 알려오면 호출 — 화면을 로그인 상태로 되돌린다. */
export function markExpired() { if (st.status === "authed") set({ status: "anon", role: null, csrf: "", expiresAt: null }); }

export function useSession(): SessionState {
  return useSyncExternalStore((cb) => { subs.add(cb); if (st.status === "unknown") void loadSession(); return () => { subs.delete(cb); }; }, getSession, () => st);
}
