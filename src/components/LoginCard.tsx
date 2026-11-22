"use client";
import { useState } from "react";
import { Card } from "@/components/ui";
import { login, logout, useSession } from "@/components/live/session";
import { formatKst } from "@/lib/time/kst";

/** Credentials stay in this form only; subsequent requests use the HttpOnly session cookie. */
export function LoginCard() {
  const s = useSession();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (s.status === "unknown") return <Card><p className="text-xs text-text-muted">세션 확인 중…</p></Card>;
  if (s.status === "authed")
    return (
      <Card>
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 text-xs text-text-muted" data-testid="session-info">로그인됨 ({s.role === "admin" ? "관리자" : "읽기 전용"}) · 만료 {s.expiresAt ? formatKst(s.expiresAt) : "-"}</p>
          <button type="button" disabled={busy} onClick={async () => { setBusy(true); setMsg(null); if (!await logout()) setMsg("로그아웃하지 못했습니다. 연결을 확인하고 다시 시도하세요."); setBusy(false); }} className="min-h-11 shrink-0 rounded-lg border border-border px-3 text-xs disabled:opacity-50">로그아웃</button>
        </div>
        {msg && <p role="status" className="mt-2 text-xs text-warn">{msg}</p>}
      </Card>
    );
  return (
    <Card>
      <form onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setMsg(null);
        const r = await login(username, password, remember);
        setPassword(""); setBusy(false);
        if (r.ok) setUsername(""); else setMsg(r.message);
      }}>
        <p className="mb-2 text-sm">관리자 로그인</p>
        <label className="text-xs text-text-muted" htmlFor="username">아이디</label>
        <input id="username" name="username" required maxLength={256} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} className="mb-2 mt-1 w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm" />
        <label className="text-xs text-text-muted" htmlFor="password">비밀번호</label>
        <input id="password" name="password" type="password" required maxLength={1024} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" className="mt-1 w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm" />
        <label className="mt-3 flex min-h-11 items-center gap-2 text-xs text-text-muted">
          <input type="checkbox" name="remember" checked={remember} onChange={(e) => setRemember(e.target.checked)} />로그인 상태 유지 (30일)
        </label>
        <p className="text-xs text-text-muted">선택하지 않으면 브라우저 세션 동안 유지되며 최대 12시간 후 만료됩니다.</p>
        <button type="submit" disabled={busy || !username || !password} className="mt-2 min-h-11 rounded-lg border border-border px-3 text-sm disabled:opacity-50">{busy ? "로그인 중…" : "로그인"}</button>
        {msg && <p role="status" className="mt-2 text-xs text-warn">{msg}</p>}
      </form>
    </Card>
  );
}
