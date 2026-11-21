"use client";
// Orchestrator engine panels for the live mobile tabs (프로젝트 / AI 팀 / PM 브리핑).
// Data: GET /api/orch. Switch changes: POST /api/orch (admin session + CSRF) → GitHub repository variables.
import { useState } from "react";
import { Card } from "@/components/ui";
import { useAuthedJson } from "@/components/live/useAuthedJson";
import { csrfHeaders, useSession } from "@/components/live/session";
import { formatKst } from "@/lib/time/kst";
import { FLAG_KEYS, latestUsage, type FlagKey, type OrchRun, type RepoView, type UsageWindow } from "@/lib/orch/model";

type OrchData = { generatedAt: string; canWrite: boolean; repos: RepoView[] };

export function useOrch() {
  return useAuthedJson<OrchData>("/api/orch", (status, body) => {
    const j = body as (OrchData & { mode?: string }) | null;
    return j?.mode === "unconfigured" ? "unconfigured" : status === 200 && j?.mode === "live" && Array.isArray(j.repos) ? j : null;
  });
}

const tone = (r: OrchRun) =>
  r.status === "blocked" ? "border-danger/50 bg-danger/10"
  : r.status === "awaiting_merge" ? "border-warn/50 bg-warn/10"
  : r.held ? "border-border bg-bg-raised"
  : r.status === "done" ? "border-ok/30"
  : "border-accent/40";
const short = (repo: string) => repo.split("/")[1] ?? repo;

function StateNote({ kind }: { kind: string }) {
  const text: Record<string, string> = {
    loading: "엔진 상태를 불러오는 중입니다.",
    notoken: "로그인이 필요합니다.",
    unauth: "로그인이 만료되었습니다.",
    unconfigured: "엔진 연결이 설정되지 않았습니다 (ORCH_REPOS, ORCH_GITHUB_TOKEN).",
    error: "엔진 상태를 불러오지 못했습니다.",
  };
  return <p className="text-sm text-text-muted" data-testid="orch-state">{text[kind] ?? text.error}</p>;
}

function RunCard({ r }: { r: OrchRun }) {
  const stepText = r.status === "waiting" ? `${r.total}개 스텝` : `스텝 ${r.passed}/${r.total} 통과${r.step && !["done", "awaiting_merge", "finalizing"].includes(r.status) ? ` · 지금 ${r.step}번` : ""}`;
  return (
    <a href={r.url} target="_blank" rel="noreferrer" className={`block rounded-xl border p-3 ${tone(r)}`} data-testid={`orch-run-${short(r.repo)}-${r.number}`}>
      <div className="flex items-start justify-between gap-2">
        <p className="break-words font-medium">{r.goal}</p>
        <span className="shrink-0 rounded-full bg-current/10 px-2 py-0.5 text-xs">{r.statusLabel}</span>
      </div>
      <p className="mt-1 text-xs text-text-muted">{short(r.repo)} #{r.number} · {stepText}{r.retries ? ` · 수정 ${r.retries}회` : ""}</p>
      {r.held && <p className="mt-1 text-xs text-yellow-100">⏸️ {r.held}</p>}
      {r.reason && <p className="mt-1 break-words text-xs text-red-200">⛔ {r.reason}</p>}
      <p className="mt-1 text-xs">다음 · {r.next}</p>
      {r.updatedAt && <p className="mt-1 text-[11px] text-text-faint">갱신 {formatKst(r.updatedAt)}</p>}
    </a>
  );
}

/** 프로젝트 탭: 저장소(프로젝트)별 진행 중인 작업. */
export function OrchRunsPanel() {
  const { state } = useOrch();
  return (
    <section aria-label="자동 진행 작업" className="space-y-2" data-testid="orch-runs">
      <h2 className="text-sm font-semibold text-text-muted">자동 진행 작업</h2>
      {state.kind !== "ok" ? <Card><StateNote kind={state.kind} /></Card> : state.data.repos.map((v) => (
        <Card key={v.repo} className="space-y-2">
          <p className="font-semibold">{short(v.repo)}</p>
          {v.runsError && <p className="text-xs text-red-200">불러오기 실패 · {v.runsError}</p>}
          {v.runs.map((r) => <RunCard key={r.number} r={r} />)}
          {!v.runs.length && !v.runsError && <p className="text-sm text-text-faint">진행 중인 작업 없음</p>}
        </Card>
      ))}
    </section>
  );
}

/** PM 브리핑 탭: 사용자 판단이 필요한 작업만. */
export function OrchDecisionsPanel() {
  const { state } = useOrch();
  if (state.kind !== "ok") return <section aria-label="엔진 결정 필요" className="space-y-2"><h2 className="text-sm font-semibold text-text-muted">엔진 · 결정 필요</h2><Card><StateNote kind={state.kind} /></Card></section>;
  const runs = state.data.repos.flatMap((v) => v.runs).filter((r) => r.needsUser || r.held);
  return (
    <section aria-label="엔진 결정 필요" className="space-y-2" data-testid="orch-decisions">
      <h2 className="text-sm font-semibold text-text-muted">엔진 · 결정 필요 · {runs.filter((r) => r.needsUser).length}</h2>
      {runs.map((r) => <RunCard key={`${r.repo}#${r.number}`} r={r} />)}
      {!runs.length && <p className="text-sm text-text-faint">없음 — 모든 작업이 자동으로 진행 중입니다.</p>}
    </section>
  );
}

const FLAG_TEXT: Record<FlagKey, { name: string; off: string }> = {
  sonnet: { name: "Claude Sonnet (구현)", off: "Opus가 대신 구현" },
  opus: { name: "Claude Opus (고난도 구현·대체 검수)", off: "Sonnet이 대신 구현, 대체 검수 없음" },
  codex: { name: "Codex (독립 검수)", off: "Opus가 바로 검수" },
  paused: { name: "전체 일시정지", off: "" },
};

/** AI 팀 탭: 저장소별 ON/OFF. 관리자 세션에서만 조작 가능. */
export function OrchSwitchesPanel() {
  const { state, reload } = useOrch();
  const session = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const canEdit = session.role === "admin" && state.kind === "ok" && state.data.canWrite;

  async function change(repo: string, key: string, value: boolean | string) {
    setBusy(`${repo}:${key}`); setMsg(null);
    try {
      const r = await fetch("/api/orch", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", ...csrfHeaders() }, body: JSON.stringify({ repo, key, value }) });
      const j = await r.json().catch(() => null);
      setMsg(r.ok ? `저장됨 · 새 작업부터 적용${j?.woke ? ", 대기 작업은 지금 재개 요청" : " (최대 20분 내 반영)"}` : `저장 실패 · ${j?.detail ?? j?.error ?? r.status}`);
      await reload();
    } catch { setMsg("저장 실패 · 네트워크 오류"); }
    finally { setBusy(null); }
  }

  return (
    <section aria-label="엔진 ON/OFF" className="space-y-2" data-testid="orch-switches">
      <h2 className="text-lg font-semibold">AI ON/OFF</h2>
      <p className="text-xs text-text-muted">끄면 새 작업만 막고, 이미 실행 중인 작업은 끝까지 진행합니다. GitHub 저장소 변수에 저장되어 이 앱이 꺼져 있어도 지켜집니다.</p>
      {msg && <p role="status" className="rounded-xl border border-border bg-bg-raised p-2 text-xs">{msg}</p>}
      {state.kind !== "ok" ? <Card><StateNote kind={state.kind} /></Card> : state.data.repos.map((v) => (
        <Card key={v.repo} className="space-y-3">
          <p className="font-semibold">{short(v.repo)}</p>
          {!v.switches ? <p className="text-xs text-red-200">스위치를 읽지 못했습니다 · {v.switchesError}</p> : <>
            {FLAG_KEYS.map((k) => {
              const on = v.switches![k];
              const label = k === "paused" ? (on ? "정지됨" : "운영 중") : on ? "ON" : "OFF";
              const active = k === "paused" ? !on : on;
              return (
                <div key={k} className="flex items-center justify-between gap-3">
                  <div><p className="text-sm">{FLAG_TEXT[k].name}</p>{!active && FLAG_TEXT[k].off && <p className="text-xs text-text-muted">꺼짐 · {FLAG_TEXT[k].off}</p>}</div>
                  <button role="switch" aria-checked={active} aria-label={`${short(v.repo)} ${FLAG_TEXT[k].name}`} disabled={!canEdit || busy !== null}
                    onClick={() => change(v.repo, k, !on)}
                    className={`min-h-11 min-w-20 shrink-0 rounded-full px-3 text-sm font-semibold disabled:opacity-50 ${active ? "bg-blue-500" : "bg-slate-700"}`}>
                    {busy === `${v.repo}:${k}` ? "…" : label}
                  </button>
                </div>
              );
            })}
            <WindowEditor repo={v.repo} value={v.switches.window} disabled={!canEdit || busy !== null} onSave={(w) => change(v.repo, "window", w)} />
          </>}
        </Card>
      ))}
      {state.kind === "ok" && !canEdit && <p className="text-xs text-text-faint">{session.role !== "admin" ? "관리자 로그인에서만 바꿀 수 있습니다." : "서버에 쓰기 토큰(ORCH_GITHUB_TOKEN)이 없어 읽기만 가능합니다."}</p>}
    </section>
  );
}

function WindowEditor({ repo, value, disabled, onSave }: { repo: string; value: string; disabled: boolean; onSave(v: string): void }) {
  const [w, setW] = useState(value);
  return (
    <div className="space-y-1">
      <label className="block text-sm" htmlFor={`win-${repo}`}>작업 시간대 (한국시간, 비우면 항상)</label>
      <div className="flex gap-2">
        <input id={`win-${repo}`} value={w} onChange={(e) => setW(e.target.value)} placeholder="08:00-24:00" inputMode="numeric"
          className="min-h-11 flex-1 rounded-xl border border-border bg-bg-raised px-3 text-sm" />
        <button disabled={disabled || w.trim() === value} onClick={() => onSave(w.trim())} className="min-h-11 rounded-xl border border-border px-3 text-sm disabled:opacity-50">저장</button>
      </div>
    </div>
  );
}

function Bar({ label, w }: { label: string; w: UsageWindow | null }) {
  const p = w?.pct ?? null;
  const left = p === null ? null : Math.max(0, Math.round((100 - p) * 10) / 10);
  const color = p === null ? "bg-slate-600" : p >= 90 ? "bg-red-400" : p >= 70 ? "bg-yellow-400" : "bg-blue-400";
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-sm">
        <span>{label}</span>
        <span className="font-semibold">{p === null ? "확인 불가" : `${p}% 사용 · ${left}% 남음`}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-700"><div className={`h-full ${color}`} style={{ width: `${Math.min(100, p ?? 0)}%` }} /></div>
      <p className="text-[11px] text-text-faint">리셋 {w?.resetsAt ? formatKst(w.resetsAt) : "확인 불가"}</p>
    </div>
  );
}

/** AI 팀 탭: 구독 사용량 (계정 전체 기준, orch:usage 스냅샷). */
export function OrchUsagePanel() {
  const { state } = useOrch();
  if (state.kind !== "ok") return <section aria-label="AI 사용량" className="space-y-2"><h2 className="text-lg font-semibold">AI 사용량</h2><Card><StateNote kind={state.kind} /></Card></section>;
  const u = latestUsage(state.data.repos);
  return (
    <section aria-label="AI 사용량" className="space-y-2" data-testid="orch-usage">
      <h2 className="text-lg font-semibold">AI 사용량</h2>
      {u && state.data.repos.some((r) => r.usageRefresh === "requested" || r.usageRefresh === "running") && <p className="text-[11px] text-text-faint" data-testid="usage-refreshing">값이 1시간 넘게 지나 새로 확인하는 중입니다. 1~2분 뒤 새로고침하면 반영됩니다.</p>}
      {!u ? <Card><p className="text-sm text-text-muted">아직 사용량 기록이 없습니다. 엔진의 usage 작업이 처음 돌면 표시됩니다.</p></Card> : <>
        <Card className="space-y-3">
          <p className="font-semibold">Claude <span className="text-xs font-normal text-text-muted">구독 전체 · 직접 대화 포함</span></p>
          {u.claude ? <><Bar label="5시간" w={u.claude.fiveHour} /><Bar label="7일" w={u.claude.sevenDay} /></> : <p className="text-sm text-text-muted">확인 불가{u.claudeError ? ` · ${u.claudeError}` : ""}</p>}
          <p className="text-[11px] text-text-faint">확인 {formatKst(u.claudeCheckedAt, "없음")}{u.claude && u.claudeError ? ` · 이번 확인: ${u.claudeError}` : ""}</p>
        </Card>
        <Card className="space-y-3">
          <div className="flex items-start justify-between gap-2">
            <p className="font-semibold">Codex</p>
            {u.codex.limited && <span className="rounded-full bg-yellow-500/15 px-2 py-0.5 text-xs text-yellow-200">한도 소진 · Opus 대체 검수</span>}
          </div>
          {u.codex.fiveHour || u.codex.weekly ? <><Bar label="5시간" w={u.codex.fiveHour} /><Bar label="주간" w={u.codex.weekly} /></> : <p className="text-sm text-text-muted">사용률 확인 불가</p>}
          {u.codex.needsLogin && <p className="rounded-lg border border-warn/50 bg-warn/10 p-2 text-xs text-yellow-100">🔑 폰 로그인 필요 — GitHub Actions → codex-login → Run workflow 후 표시되는 코드로 승인</p>}
          <p className="text-[11px] text-text-faint">확인 {formatKst(u.codex.checkedAt, "없음")}{u.codex.error && !u.codex.needsLogin ? ` · 이번 조회: ${u.codex.error}` : ""}</p>
        </Card>
      </>}
    </section>
  );
}
