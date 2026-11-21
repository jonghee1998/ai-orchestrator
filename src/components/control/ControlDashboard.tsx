"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Card, PageTitle } from "@/components/ui";
import { LoginCard } from "@/components/LoginCard";
import { csrfHeaders, useSession } from "@/components/live/session";
import { SESSION_MARK } from "@/lib/session/client";
import { ScopeNotice } from "@/components/ScopeNotice";
import { sharedGet, useRegisterRefresh } from "@/components/live/refresh";
import { parseTrust, trustLabel } from "@/lib/runs/run-trust";
import { formatKst } from "@/lib/time/kst";

type Agent = {
  key: string; provider: string; enabled: boolean; effective: boolean; blockedReason: string | null; cancelSupported: boolean;
  lastAck: string | null; lastRun: string | null; lastHeartbeat: string | null; lastStatus: string | null;
  running: number; queued: number; held: number; orchestratorDispatches: number; suppressedByGate: number;
  providerUsage: { state: string; reason?: string };
};
type Run = { dispatchId: string; issueNumber: number; agent: string; status: string; verified: boolean; trust?: unknown; held: string | null; lastActivityAt: string; lastError: string | null; evidence: { kind: string; url: string }[] };
type Schedule = { enabled: boolean; timezone: string; windows: { days: number[]; start: string; end: string }[] };
type Snap = {
  mode: "live"; generatedAt: string; lastUpdate: string | null; presets: string[]; agents: Agent[]; runs: Run[]; errors: Run[]; handoffs: Run[];
  audit: { at: string; actor: string; action: string; detail: string }[]; notes: string[];
  control: { version: number; preset: string; claudeProvider: boolean; allowReroute: boolean; schedule: Schedule };
};
type State = { kind: "loading" } | { kind: "unconfigured" } | { kind: "error" } | { kind: "ok"; snap: Snap };

const NAMES: Record<string, string> = { gpt: "GPT", "claude-sonnet": "Claude Sonnet", "claude-opus": "Claude Opus", codex: "Codex" };
const PRESET_LABEL: Record<string, string> = { "gpt-only": "GPT만", "claude-only": "Claude만", "all-enabled": "전체 켜기", "all-paused": "전체 일시정지" };
const t = (s: string | null) => formatKst(s);

export default function ControlDashboard({ embedded = false, readOnly = false }: { embedded?: boolean; readOnly?: boolean }) {
  const [s, setS] = useState<State>({ kind: "loading" });
  const sess = useSession();
  const token = sess.status === "authed" ? SESSION_MARK : "";
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  const good = useRef(false);
  const [staleErr, setStaleErr] = useState(false);
  // #81: 실패 시 마지막 정상 상태 유지, 성공 여부 반환.
  const load = useCallback(async (): Promise<boolean> => {
    if (!token.trim()) { seq.current++; good.current = false; setStaleErr(false); setS({ kind: "error" }); return false; }
    const my = ++seq.current; // stale-response guard
    const keep = (next: State) => { if (my !== seq.current) return false; if (good.current) setStaleErr(true); else setS(next); return false; };
    try {
      const r = await sharedGet("/api/dashboard", token.trim());
      if (my !== seq.current) return false;
      const j = (r.body ?? {}) as Record<string, any>;
      if (j.mode === "unconfigured") return keep({ kind: "unconfigured" });
      if (r.status >= 200 && r.status < 300 && j.mode === "live") { good.current = true; setStaleErr(false); setS({ kind: "ok", snap: j as Snap }); return true; }
      if (r.status === 401) { good.current = false; setStaleErr(false); setS({ kind: "error" }); return false; }
      return keep({ kind: "error" });
    } catch { return keep({ kind: "error" }); }
  }, [token]);
  useEffect(() => { load(); const id = setInterval(load, 15000); return () => clearInterval(id); }, [load]);

  useRegisterRefresh("/api/dashboard", load);

  async function send(body: Record<string, unknown>) {
    if (readOnly) return;
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/control", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", ...csrfHeaders() }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      setMsg(r.ok ? "적용됨" : r.status === 401 ? "세션이 만료되었습니다. 다시 로그인하세요" : r.status === 403 ? "관리자 권한 또는 CSRF 검증 실패 (읽기 전용 세션이면 관리자 계정으로 로그인)" : r.status === 503 ? "서버 제어가 설정되지 않았습니다" : r.status === 409 ? `충돌/미지원: ${j.detail ?? j.error}` : `실패: ${j.error ?? r.status}`);
      await load();
    } catch { setMsg("요청 실패"); } finally { setBusy(false); }
  }

  return (
    <div>
      {!embedded && <><PageTitle title="배정 설정" subtitle="새 작업 배정 정책과 저장된 상태" /><div className="mb-3"><ScopeNotice /></div><div className="mb-3"><LoginCard /></div></>}
      {s.kind === "loading" && <p className="text-sm text-text-faint">불러오는 중…</p>}
      {s.kind === "unconfigured" && <Card><p className="text-sm">실행 저장소가 설정되지 않았습니다 (RUN_STORE_PATH). 연결되지 않은 상태이며 어떤 에이전트도 dispatch 되지 않습니다.</p></Card>}
      {s.kind === "error" && <Card><p className="text-sm">상태를 불러오지 못했습니다.</p><button className="mt-2 rounded-lg border border-border px-3 py-2 text-xs" onClick={load}>다시 시도</button></Card>}
      {s.kind === "ok" && staleErr && <p role="status" className="mb-2 text-xs text-warn">최신 갱신 실패 — 마지막 정상 데이터를 표시 중입니다.</p>}
      {s.kind === "ok" && <Body snap={s.snap} send={send} busy={busy || readOnly} msg={msg} reload={load} />}
    </div>
  );
}

function Body({ snap, send, busy, msg, reload }: { snap: Snap; send: (b: Record<string, unknown>) => void; busy: boolean; msg: string | null; reload: () => void }) {
  const c = snap.control;
  const v = c.version;
  const sch = c.schedule;
  const [tz, setTz] = useState(sch.timezone);
  const [start, setStart] = useState(sch.windows[0]?.start ?? "09:00");
  const [end, setEnd] = useState(sch.windows[0]?.end ?? "18:00");
  const [schOn, setSchOn] = useState(sch.enabled);
  const btn = "min-h-11 rounded-lg border border-border px-3 text-sm disabled:opacity-50";
  return (
    <div className="space-y-4">
      <p className="text-xs text-text-faint">마지막 갱신 {t(snap.lastUpdate)} · 설정 v{v} · 배정 방식 {PRESET_LABEL[c.preset] ?? c.preset}</p>

      <Card>
        <p className="text-xs text-text-muted">변경은 관리자 세션(서버 검증 쿠키 + CSRF)으로만 허용됩니다.</p>
        {msg && <p role="status" className="mt-2 text-xs">{msg}</p>}
      </Card>

      <section aria-label="배정 방식"><h2 className="mb-2 text-sm font-semibold">배정 방식</h2>
        <div className="grid grid-cols-2 gap-2">
          {snap.presets.map((p) => <button key={p} disabled={busy} className={`${btn} ${c.preset === p ? "border-accent text-accent" : ""}`} onClick={() => send({ action: "preset", name: p })}>{PRESET_LABEL[p] ?? p}</button>)}
        </div>
      </section>

      <section aria-label="에이전트"><h2 className="mb-2 text-sm font-semibold">에이전트</h2>
        <Card className="mb-2 flex items-center justify-between">
          <span className="text-sm">Claude 전체 (Sonnet+Opus)</span>
          <button disabled={busy} className={btn} aria-pressed={c.claudeProvider} onClick={() => send({ action: "set_claude_provider", enabled: !c.claudeProvider, expectedVersion: v })}>{c.claudeProvider ? "ON" : "OFF"}</button>
        </Card>
        <div className="space-y-2">
          {snap.agents.map((a) => (
            <Card key={a.key}>
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">{NAMES[a.key]}</p>
                  <p className="text-xs text-text-muted">{a.effective ? "새 작업 배정 가능" : `차단: ${a.blockedReason}`}</p>
                </div>
                <button disabled={busy} className={btn} aria-pressed={a.enabled} aria-label={`${NAMES[a.key]} 토글`} onClick={() => send({ action: "set_agent", agent: a.key, enabled: !a.enabled, expectedVersion: v })}>{a.enabled ? "ON" : "OFF"}</button>
              </div>
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-text-muted">
                <dt>작업 수신 확인</dt><dd>{t(a.lastAck)}</dd>
                <dt>최근 실행</dt><dd>{t(a.lastRun)}</dd>
                <dt>최근 응답</dt><dd>{t(a.lastHeartbeat)}</dd>
                <dt>상태</dt><dd>{a.lastStatus ?? "기록 없음"}</dd>
                <dt>진행 중/시작 대기/보류</dt><dd>{a.running}/{a.queued}/{a.held}</dd>
                <dt>orchestrator 호출</dt><dd>{a.orchestratorDispatches} (차단 {a.suppressedByGate})</dd>
                <dt>제공사 사용량/비용</dt><dd>확인되지 않음 (사용량 측정 미연결)</dd>
                <dt>취소</dt><dd>{a.cancelSupported ? "지원" : "미지원 (drain)"}</dd>
              </dl>
            </Card>
          ))}
        </div>
      </section>

      <section aria-label="정책"><h2 className="mb-2 text-sm font-semibold">정책 · 스케줄</h2>
        <Card className="space-y-3">
          <div className="flex items-center justify-between"><span className="text-sm">대기 작업 재라우팅 허용</span>
            <button disabled={busy} className={btn} aria-pressed={c.allowReroute} onClick={() => send({ action: "set_reroute", enabled: !c.allowReroute, expectedVersion: v })}>{c.allowReroute ? "ON" : "OFF(보류)"}</button></div>
          <div className="space-y-2 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" checked={schOn} onChange={(e) => setSchOn(e.target.checked)} /> 평일 스케줄 사용 (기본 꺼짐)</label>
            <div className="grid grid-cols-3 gap-2">
              <input aria-label="시간대" value={tz} onChange={(e) => setTz(e.target.value)} className="rounded-lg border border-border bg-transparent px-2 py-2 text-xs" />
              <input aria-label="시작" value={start} onChange={(e) => setStart(e.target.value)} className="rounded-lg border border-border bg-transparent px-2 py-2 text-xs" />
              <input aria-label="종료" value={end} onChange={(e) => setEnd(e.target.value)} className="rounded-lg border border-border bg-transparent px-2 py-2 text-xs" />
            </div>
            <button disabled={busy} className={btn} onClick={() => send({ action: "set_schedule", expectedVersion: v, schedule: { enabled: schOn, timezone: tz, windows: schOn ? [{ days: [1, 2, 3, 4, 5], start, end }] : [] } })}>스케줄 저장</button>
            <p className="text-xs text-text-faint">현재: {sch.enabled ? `${sch.timezone} 평일 ${sch.windows[0]?.start}–${sch.windows[0]?.end}` : "사용 안 함"}</p>
          </div>
        </Card>
      </section>

      <section aria-label="실행 현황"><h2 className="mb-2 text-sm font-semibold">작업 · 큐 · 증거</h2>
        {snap.runs.length === 0 && <p className="text-xs text-text-faint">기록된 실행이 없습니다.</p>}
        <div className="space-y-2">
          {snap.runs.slice(0, 15).map((r) => (
            <Card key={r.dispatchId}>
              <p className="text-sm break-all">#{r.issueNumber} · {NAMES[r.agent] ?? r.agent} · <b>{r.held ? `보류(${r.held})` : r.status}</b>{` (${trustLabel(parseTrust(r.trust), r.status).text})`}</p>
              <p className="text-xs text-text-faint">{t(r.lastActivityAt)}{r.lastError ? ` · ${r.lastError}` : ""}</p>
              {r.evidence.map((e) => <a key={e.url} href={e.url} className="block break-all text-xs underline">{e.kind}: {e.url}</a>)}
              {!r.held && ["acknowledged", "running", "unknown"].includes(r.status) && <button disabled={busy} className="mt-1 text-xs underline" onClick={() => send({ action: "cancel", dispatchId: r.dispatchId })}>취소 요청 (미지원 시 drain)</button>}
            </Card>
          ))}
        </div>
        {snap.errors.length > 0 && <p className="mt-2 text-xs">오류 {snap.errors.length}건 (위 목록 참고)</p>}
      </section>

      <section aria-label="감사 로그"><h2 className="mb-2 text-sm font-semibold">감사 로그</h2>
        <Card><ul className="space-y-1 text-xs text-text-muted">{snap.audit.length === 0 && <li>기록 없음</li>}{snap.audit.slice(0, 15).map((a, i) => <li key={i} className="break-all">{t(a.at)} · {a.actor} · {a.action} · {a.detail}</li>)}</ul></Card>
      </section>

      <div className="space-y-1 text-[11px] text-text-faint">{snap.notes.map((n) => <p key={n}>• {n}</p>)}</div>
      <button className={btn} onClick={reload}>새로고침</button>
    </div>
  );
}
