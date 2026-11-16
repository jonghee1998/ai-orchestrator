"use client";
import { useState } from "react";
import { Card } from "@/components/ui";
import { login, logout, useSession } from "@/components/live/session";

/** 한 번 로그인하면 서버가 HttpOnly 세션 쿠키(30일)를 발급한다. 토큰은 이 입력창 밖으로 저장되지 않는다. */
export function LoginCard() {
  const s = useSession();
  const [tok, setTok] = useState(""); const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  if (s.status === "unknown") return <Card><p className="text-xs text-text-faint">세션 확인 중…</p></Card>;
  if (s.status === "authed")
    return (
      <Card className="flex items-center justify-between gap-3" >
        <p className="min-w-0 text-xs text-text-muted" data-testid="session-info">로그인됨 ({s.role === "admin" ? "관리자" : "읽기 전용"}) · 만료 {s.expiresAt ? s.expiresAt.slice(0, 10) : "-"}</p>
        <button type="button" onClick={() => { void logout(); }} className="min-h-11 shrink-0 rounded-lg border border-border px-3 text-xs">로그아웃</button>
      </Card>
    );
  return (
    <Card>
      <form onSubmit={async (e) => { e.preventDefault(); setBusy(true); setMsg(null); const r = await login(tok); setBusy(false); if (r.ok) setTok(""); else setMsg(r.message); }}>
        <label className="text-xs text-text-muted" htmlFor="tok">로그인 — 토큰 (읽기/관리자). 한 번 입력하면 이 브라우저에 30일간 안전한 세션이 유지됩니다.</label>
        <input id="tok" type="password" value={tok} onChange={(e) => setTok(e.target.value)} autoComplete="off" className="mt-1 w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm" />
        <button type="submit" disabled={busy || !tok.trim()} className="mt-2 min-h-11 rounded-lg border border-border px-3 text-sm disabled:opacity-50">로그인</button>
        {msg && <p role="status" className="mt-2 text-xs text-warn">{msg}</p>}
      </form>
    </Card>
  );
}
