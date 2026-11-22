"use client";
import { useState } from "react";
import { BUTTON, Card, FIELD, PRIMARY_BUTTON } from "@/components/ui";
import { login, logout, useSession } from "@/components/live/session";
import { formatKst } from "@/lib/time/kst";

/** Credentials stay in this form only; subsequent requests use the HttpOnly session cookie.
 *  `plain`: 이미 카드 모양인 곳(계정 접기) 안에서는 Card 없이 그린다 (카드 안 카드 금지). */
export function LoginCard({ plain = false }: { plain?: boolean } = {}) {
  const s = useSession();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const Shell = plain ? PlainShell : Card;
  if (s.status === "unknown") return <Shell><p className="text-xs text-text-muted">세션 확인 중…</p></Shell>;
  if (s.status === "authed")
    return (
      <Shell>
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 text-xs tabular-nums text-text-muted" data-testid="session-info">로그인됨 ({s.role === "admin" ? "관리자" : "읽기 전용"}) · 만료 {s.expiresAt ? formatKst(s.expiresAt) : "-"}</p>
          <button type="button" disabled={busy} onClick={async () => { setBusy(true); setMsg(null); if (!await logout()) setMsg("로그아웃하지 못했습니다. 연결을 확인하고 다시 시도하세요."); setBusy(false); }} className={`${BUTTON} shrink-0`}>로그아웃</button>
        </div>
        {msg && <p role="status" className="mt-2 text-xs text-warn">{msg}</p>}
      </Shell>
    );
  return (
    <Shell>
      <form onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setMsg(null);
        const r = await login(username, password, remember);
        setPassword(""); setBusy(false);
        if (r.ok) setUsername(""); else setMsg(r.message);
      }}>
        <p className="mb-3 text-base font-[750] tracking-[-0.02em]">관리자 로그인</p>
        <label className="text-xs text-text-muted" htmlFor="username">아이디</label>
        <input id="username" name="username" required maxLength={256} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} className={`${FIELD} mb-3 mt-1 min-h-11`} />
        <label className="text-xs text-text-muted" htmlFor="password">비밀번호</label>
        <input id="password" name="password" type="password" required maxLength={1024} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" className={`${FIELD} mt-1 min-h-11`} />
        <label className="mt-3 flex min-h-11 items-center gap-2 text-xs text-text-muted">
          <input type="checkbox" name="remember" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="h-4 w-4 accent-accent" />로그인 상태 유지 (30일)
        </label>
        <p className="text-xs text-text-muted">선택하지 않으면 브라우저 세션 동안 유지되며 최대 12시간 후 만료됩니다.</p>
        <button type="submit" disabled={busy || !username || !password} className={`${PRIMARY_BUTTON} mt-3 h-11 w-full justify-center text-sm`}>{busy ? "로그인 중…" : "로그인"}</button>
        {msg && <p role="status" className="mt-2 text-xs text-warn">{msg}</p>}
      </form>
    </Shell>
  );
}

function PlainShell({ children }: { children: React.ReactNode }) {
  return <div>{children}</div>;
}
