"use client";
import { useAuthedJson } from "@/components/live/useAuthedJson";
import { Card } from "@/components/ui";
import { StaleNotice } from "@/components/live/LiveStatus";
import { parseTrust, trustLabel } from "@/lib/runs/run-trust";
import { formatKst } from "@/lib/time/kst";

type Run = { dispatchId: string; issueNumber: number; agent: string; status: string; verified: boolean; trust?: unknown; lastActivityAt: string; lastError: string | null; evidence: { kind: string; url: string }[];
  collaboration?: { baseBranch: string; baseSha: string; targetSha: string; step: string; cycle: number } | null;
  execution?: { exitCode: number; summary: string; headSha: string; tests: { command: string; exitCode: number }[] } | null };
export default function RunsPanel() {
  // #81: 전역 새로고침·공유 GET·마지막 정상 데이터 유지를 위해 공용 로더 사용.
  const { state, error } = useAuthedJson<Run[]>("/api/runs", (st, b) => {
    const j = (b ?? {}) as { mode?: string; runs?: Run[] };
    if (j.mode === "unconfigured") return "unconfigured";
    return st >= 200 && st < 300 && Array.isArray(j.runs) ? j.runs : null;
  });
  const s = state.kind === "ok" ? { kind: "ok" as const, runs: state.data } : state.kind === "unconfigured" ? { kind: "unconfigured" as const } : state.kind === "loading" ? { kind: "loading" as const } : { kind: "error" as const };
  return (
    <section className="mb-4" aria-label="실행 추적">
      <h2 className="mb-2 text-sm font-semibold">실행 추적</h2>
      {s.kind === "loading" && <p className="text-xs text-text-faint">불러오는 중…</p>}
      {s.kind === "unconfigured" && <p className="text-xs text-text-faint">실행 저장소가 설정되지 않았습니다 (RUN_STORE_PATH).</p>}
      {s.kind === "error" && <p className="text-xs text-text-faint">실행 상태를 불러오지 못했습니다.</p>}
      {s.kind === "ok" && <StaleNotice error={error} />}
      {s.kind === "ok" && s.runs.length === 0 && <p className="text-xs text-text-faint">기록된 실행이 없습니다.</p>}
      {s.kind === "ok" && s.runs.map((r) => { const t = parseTrust(r.trust), ev = trustLabel(t, r.status), self = t?.origin === "session"; return (
        <Card key={r.dispatchId}>
          <p className="text-sm">#{r.issueNumber} · {r.agent} · <b>{r.status}</b> <span className={ev.verified ? "text-ok" : "text-warn"}>({ev.text})</span></p>
          <p className="text-xs text-text-faint">최근 활동 {formatKst(r.lastActivityAt)}{r.lastError ? ` · ${r.lastError}` : ""}</p>
          {r.collaboration && <p className="break-all text-xs text-text-faint">PM 기준 {r.collaboration.baseBranch}@{r.collaboration.baseSha.slice(0, 12)} · {r.collaboration.step} #{r.collaboration.cycle} · 대상 {r.collaboration.targetSha.slice(0, 12)}</p>}
          {r.execution && <div className="text-xs">{self && <p className="text-warn">세션 자기보고 — 아래 실행·테스트 결과는 독립 검증되지 않았고 프로세스 정리 증명이 없습니다.</p>}
            <p>{r.execution.summary}</p><p>{self ? "보고된 " : ""}실행 종료 코드 {r.execution.exitCode} · 커밋 {r.execution.headSha.slice(0, 12)}</p>
            {r.execution.tests.map((t, i) => <p key={i}>{t.command} · {self ? "보고된 " : ""}종료 코드 {t.exitCode}</p>)}</div>}
          {r.evidence.map((e) => <a key={e.url} href={e.url} className="block text-xs underline">{e.kind}: {e.url}</a>)}
        </Card>
      ); })}
    </section>
  );
}
