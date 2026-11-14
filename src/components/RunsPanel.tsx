"use client";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui";

type Run = { dispatchId: string; issueNumber: number; agent: string; status: string; verified: boolean; lastActivityAt: string; lastError: string | null; evidence: { kind: string; url: string }[];
  collaboration?: { baseBranch: string; baseSha: string; targetSha: string; step: string; cycle: number } | null;
  execution?: { exitCode: number; summary: string; headSha: string; tests: { command: string; exitCode: number }[] } | null };
type State = { kind: "loading" } | { kind: "unconfigured" } | { kind: "error" } | { kind: "ok"; runs: Run[] };

export default function RunsPanel() {
  const [s, setS] = useState<State>({ kind: "loading" });
  useEffect(() => {
    let live = true;
    fetch("/api/runs", { cache: "no-store", headers: { "x-admin-token": (() => { try { return sessionStorage.getItem("ctl-token") ?? ""; } catch { return ""; } })() } })
      .then((r) => r.json().then((j) => ({ r, j })))
      .then(({ r, j }) => { if (live) setS(j.mode === "unconfigured" ? { kind: "unconfigured" } : r.ok ? { kind: "ok", runs: j.runs } : { kind: "error" }); })
      .catch(() => live && setS({ kind: "error" }));
    return () => { live = false; };
  }, []);
  return (
    <section className="mb-4" aria-label="실행 추적">
      <h2 className="mb-2 text-sm font-semibold">실행 추적</h2>
      {s.kind === "loading" && <p className="text-xs text-text-faint">불러오는 중…</p>}
      {s.kind === "unconfigured" && <p className="text-xs text-text-faint">실행 저장소가 설정되지 않았습니다 (RUN_STORE_PATH).</p>}
      {s.kind === "error" && <p className="text-xs text-text-faint">실행 상태를 불러오지 못했습니다.</p>}
      {s.kind === "ok" && s.runs.length === 0 && <p className="text-xs text-text-faint">기록된 실행이 없습니다.</p>}
      {s.kind === "ok" && s.runs.map((r) => (
        <Card key={r.dispatchId}>
          <p className="text-sm">#{r.issueNumber} · {r.agent} · <b>{r.status}</b>{r.status === "unknown" ? " (수신 미확인)" : r.verified ? " (agent 확인)" : ""}</p>
          <p className="text-xs text-text-faint">최근 활동 {r.lastActivityAt}{r.lastError ? ` · ${r.lastError}` : ""}</p>
          {r.collaboration && <p className="break-all text-xs text-text-faint">PM 기준 {r.collaboration.baseBranch}@{r.collaboration.baseSha.slice(0, 12)} · {r.collaboration.step} #{r.collaboration.cycle} · 대상 {r.collaboration.targetSha.slice(0, 12)}</p>}
          {r.execution && <div className="text-xs"><p>{r.execution.summary}</p><p>실행 종료 코드 {r.execution.exitCode} · 커밋 {r.execution.headSha.slice(0, 12)}</p>
            {r.execution.tests.map((t, i) => <p key={i}>{t.command} · 종료 코드 {t.exitCode}</p>)}</div>}
          {r.evidence.map((e) => <a key={e.url} href={e.url} className="block text-xs underline">{e.kind}: {e.url}</a>)}
        </Card>
      ))}
    </section>
  );
}
