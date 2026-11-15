"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Card, PageTitle } from "@/components/ui";
import { ScopeNotice } from "@/components/ScopeNotice";
import { sharedGet, useRegisterRefresh } from "@/components/live/refresh";
import { parseTrust, trustLabel } from "@/lib/runs/run-trust";

type Agent = { key: string; enabled: boolean; effective: boolean; blockedReason: string | null; lastAck: string | null; lastHeartbeat: string | null; lastStatus: string | null; externalGate?: { state: "none" | "fresh" | "stale"; lastAt?: string; lastAllowed?: boolean; count?: number }; running: number; queued: number; held: number };
type Run = { dispatchId: string; issueNumber: number; agent: string; status: string; verified: boolean; trust?: unknown; held: string | null; lastActivityAt: string; lastError: string | null };
type Snap = { mode: "live"; generatedAt: string; agents: Agent[]; runs: Run[]; errors: Run[]; control: { preset: string }; audit: { at: string; actor: string; action: string; detail: string }[] };
type GH = { state: "unconfigured" | "configured_unverified" | "live" | "error"; repo: string | null; tokenSource: string; openIssues: number | null };
type Ready = { github?: GH; items: { id: string; label: string; state: "ok" | "missing" | "blocked"; detail: string }[]; releaseBlocked: boolean; githubEvidence?: { ready: boolean; detail: string } };
type St = { kind: "loading" } | { kind: "notoken" } | { kind: "unauth"; reason?: string } | { kind: "unconfigured" } | { kind: "error"; detail?: string } | { kind: "ok"; snap: Snap; ready: Ready | null };

const NAMES: Record<string, string> = { gpt: "GPT", "claude-sonnet": "Claude Sonnet", "claude-opus": "Claude Opus", codex: "Codex" };
const t = (s: string | null) => (s ? s.replace("T", " ").slice(0, 19) + "Z" : "없음");
const DOT: Record<string, string> = { ok: "bg-green-500", missing: "bg-yellow-500", blocked: "bg-red-500" };

export default function OverviewDashboard() {
  const [token, setToken] = useState("");
  const [s, setS] = useState<St>({ kind: "loading" });
  const seq = useRef(0);
  useEffect(() => { try { setToken(sessionStorage.getItem("ctl-token") ?? ""); } catch { /* ignore */ } }, []);
  const good = useRef(false);
  const [staleErr, setStaleErr] = useState<string | null>(null);
  // #81: 오류 시 마지막 정상 스냅샷 유지(staleErr 로 별도 표시). 성공 여부를 반환해 전역 새로고침이 집계한다.
  const load = useCallback(async (): Promise<boolean> => {
    if (!token.trim()) { seq.current++; good.current = false; setStaleErr(null); setS({ kind: "notoken" }); return false; }
    const my = ++seq.current;
    const keep = (next: St, detail: string) => { if (my !== seq.current) return false; if (good.current) setStaleErr(detail); else setS(next); return false; };
    try {
      const tk = token.trim();
      const [r, rr] = await Promise.all([sharedGet("/api/dashboard", tk), sharedGet("/api/readiness", tk)]);
      if (my !== seq.current) return false;
      const j = (r.body ?? {}) as Record<string, any>;
      if (r.status === 401) { good.current = false; setStaleErr(null); setS({ kind: "unauth", reason: j.reason }); return false; }
      if (j.mode === "unconfigured" || r.status === 503) return keep({ kind: "unconfigured" }, "서버 설정 없음 (unconfigured)");
      const okHttp = r.status >= 200 && r.status < 300;
      if (!okHttp || j.mode !== "live") { const d = `HTTP ${r.status}${typeof j.category === "string" ? ` · 원인 분류: ${j.category}` : ""}`; return keep({ kind: "error", detail: d }, d); }
      good.current = true; setStaleErr(null);
      setS({ kind: "ok", snap: j as Snap, ready: rr.status >= 200 && rr.status < 300 ? (rr.body as Ready) : null });
      return true;
    } catch { return keep({ kind: "error", detail: "네트워크 오류 (서버에 도달하지 못함)" }, "네트워크 오류 (서버에 도달하지 못함)"); }
  }, [token]);
  useEffect(() => { load(); const id = setInterval(load, 15000); return () => clearInterval(id); }, [load]);
  useRegisterRefresh("/api/dashboard+readiness", load);
  const save = (v: string) => { setToken(v); try { sessionStorage.setItem("ctl-token", v); } catch { /* ignore */ } };

  return (
    <div className="space-y-4">
      <PageTitle title="AI Orchestrator" subtitle="실제 상태 · 증거 기반 (가짜 텔레메트리 없음)" />
      <ScopeNotice />
      <Card>
        <label className="text-xs text-text-muted" htmlFor="tok">토큰 (읽기/관리자, 이 탭에만 저장)</label>
        <input id="tok" type="password" value={token} onChange={(e) => save(e.target.value)} autoComplete="off" className="mt-1 w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm" />
      </Card>
      {s.kind === "loading" && <p className="text-sm text-text-faint">불러오는 중…</p>}
      {s.kind === "notoken" && <Card><p className="text-sm">토큰을 입력하면 실제 상태를 불러옵니다. 연결 전에는 어떤 상태도 표시하지 않습니다.</p></Card>}
      {s.kind === "unauth" && <Card><p className="text-sm">{s.reason === "token_missing" ? "토큰이 비어 있습니다 (401)." : "토큰이 올바르지 않습니다 (401). 서버에는 토큰이 설정되어 있으나 입력값과 일치하지 않습니다."}</p></Card>}
      {s.kind === "unconfigured" && <Card><p className="text-sm">서버 저장소/인증이 설정되지 않았습니다 (DATABASE_URL, CONTROL_*_TOKEN). 어떤 에이전트도 dispatch 되지 않습니다.</p></Card>}
      {s.kind === "error" && <Card><p className="text-sm">상태를 불러오지 못했습니다.</p>{s.detail && <p className="mt-1 text-xs text-text-faint">{s.detail}</p>}<button className="mt-2 min-h-11 rounded-lg border border-border px-3 text-xs" onClick={load}>다시 시도</button></Card>}
      {s.kind === "ok" && (
        <>
          {staleErr && <p role="status" className="text-xs text-warn">최신 갱신 실패 ({staleErr}) — 아래는 마지막 정상 데이터입니다.</p>}
          <p className="text-xs text-text-faint">갱신 {t(s.snap.generatedAt)} · 프리셋 {s.snap.control.preset} · 오류 {s.snap.errors.length}건</p>
          <section aria-label="에이전트 상태" className="space-y-2">
            <div className="flex items-center justify-between"><h2 className="text-sm font-semibold text-text-muted">에이전트</h2><Link href="/control" className="text-xs text-accent">제어 →</Link></div>
            {s.snap.agents.map((a) => (
              <Card key={a.key} className="flex items-center justify-between gap-3">
                <div className="min-w-0"><p className="font-medium">{NAMES[a.key] ?? a.key}</p>
                  <p className="text-xs text-text-muted">{a.effective ? "dispatch 허용" : `차단: ${a.blockedReason}`} · 실행/대기/보류 {a.running}/{a.queued}/{a.held}</p>
                  <p className="text-[11px] text-text-faint">ACK {t(a.lastAck)} · 상태 {a.lastStatus ?? "기록 없음"}</p>
                  <p className="text-[11px] text-text-faint">외부 루틴 게이트 증거: {!a.externalGate || a.externalGate.state === "none" ? "없음 — 외부 루틴 통제 미확인(unknown)" : `${a.externalGate.state === "fresh" ? "최근" : "오래됨"} ${t(a.externalGate.lastAt ?? null)} · ${a.externalGate.lastAllowed ? "허용" : "차단"} 응답 (${a.externalGate.count}회)`}</p></div>
                <span className={`shrink-0 rounded-full px-2 py-1 text-xs ${a.enabled ? "bg-green-900/40 text-green-200" : "bg-bg-raised text-text-faint"}`}>{a.enabled ? "ON" : "OFF"}</span>
              </Card>
            ))}
          </section>
          <section aria-label="최근 실행" className="space-y-2">
            <div className="flex items-center justify-between"><h2 className="text-sm font-semibold text-text-muted">큐 · 최근 활동</h2><Link href="/tasks" className="text-xs text-accent">작업 큐 →</Link></div>
            {s.snap.runs.length === 0 && <p className="text-xs text-text-faint">기록된 실행이 없습니다.</p>}
            {s.snap.runs.slice(0, 6).map((r) => (
              <Card key={r.dispatchId}><p className="break-all text-sm">#{r.issueNumber} · {NAMES[r.agent] ?? r.agent} · <b>{r.held ? `보류(${r.held})` : r.status}</b>{` (${trustLabel(parseTrust(r.trust), r.status).text})`}</p>
                <p className="text-xs text-text-faint">{t(r.lastActivityAt)}{r.lastError ? ` · ${r.lastError}` : ""}</p></Card>
            ))}
            <Link href="/activity" className="block text-xs text-accent">전체 활동 →</Link>
          </section>
          <p className="text-xs text-text-faint" aria-label="GitHub 연결 상태">GitHub 큐: {!s.ready?.github ? "unknown (readiness 미수신)" : s.ready.github.state === "live" ? `live · ${s.ready.github.repo} (읽기 확인, 열린 이슈 ${s.ready.github.openIssues ?? "unknown"})` : s.ready.github.state === "unconfigured" ? "미설정 (unconfigured)" : "오류 — 연결 실패(unknown)"}</p>
          {s.ready && (
            <section aria-label="릴리스 준비도" className="space-y-2">
              <h2 className="text-sm font-semibold text-text-muted">릴리스 준비도(런타임 포함) · {s.ready.releaseBlocked ? "차단됨" : "준비됨"}</h2>
              <p className="text-xs" aria-label="GitHub 읽기 전용 준비도">GitHub 읽기 전용 증거 범위 · {!s.ready.githubEvidence ? "unknown" : s.ready.githubEvidence.ready ? "준비됨" : "미준비"}{s.ready.githubEvidence ? <span className="text-text-faint"> — {s.ready.githubEvidence.detail}</span> : null}</p>
              <Card><ul className="space-y-2 text-xs">{s.ready.items.map((i) => (
                <li key={i.id} className="flex gap-2"><span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${DOT[i.state]}`} aria-label={i.state} /><span><b>{i.label}</b> — {i.detail}</span></li>
              ))}</ul></Card>
            </section>
          )}
        </>
      )}
    </div>
  );
}
