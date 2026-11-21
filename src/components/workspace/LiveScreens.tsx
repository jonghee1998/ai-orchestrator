"use client";
// Issue #116 / T2 — live read-only mobile tabs on WorkspaceModel v1. No mutation controls; demo simulation stays separate.
import Link from "next/link";
import { Card, PageTitle } from "@/components/ui";
import { formatKst } from "@/lib/time/kst";
import { useWorkspaceModel } from "./useWorkspace";
import { Account } from "./Account";
import { OrchDecisionsPanel, OrchRunsPanel, OrchSwitchesPanel, OrchUsagePanel } from "@/components/orch/OrchPanels";
import { PART_LABEL, type PartState, type WorkspaceModelV1 } from "@/lib/workspace/model";

const PART_STATE: Record<PartState, string> = { ok: "연결됨", loading: "불러오는 중", unconfigured: "미설정", unauthenticated: "로그인 필요", error: "오류" };
const when = (iso?: string) => formatKst(iso, "확인 불가");

export function SourceBanner({ m }: { m: WorkspaceModelV1 }) {
  const tone = m.source === "live" ? "border-ok/40 bg-ok/10" : m.source === "loading" ? "border-border bg-bg-card" : "border-warn/50 bg-warn/10";
  return <section aria-label="데이터 출처" data-testid="source-banner" data-source={m.source} className={`rounded-xl border p-3 text-sm ${tone}`}>
    <p className="font-medium">{m.sourceLabel}{m.generatedAt ? ` · 기준 ${when(m.generatedAt)}` : ""}</p>
    <ul className="mt-1 space-y-0.5 text-xs text-text-muted">{(Object.keys(m.parts) as (keyof typeof m.parts)[]).map(k => <li key={k}>{PART_LABEL[k]} · {PART_STATE[m.parts[k]]}</li>)}</ul>
    {m.notes.map(n => <p key={n} className="mt-1 text-xs text-yellow-100">{n}</p>)}
  </section>;
}

export function LiveProjectsScreen({ projectId }: { projectId?: string; taskId?: string }) {
  if (projectId) return <div className="space-y-4"><Link href="/projects" className="inline-flex min-h-11 items-center text-accent">← 프로젝트</Link><Card><p>프로젝트 상세는 자동 진행 작업으로 통합되었습니다</p></Card><Account /></div>;
  return <div className="space-y-4"><PageTitle title="AI Orchestrator" subtitle="실제 GitHub 기록 기준" /><OrchRunsPanel /><Account /></div>;
}
export function LiveAgentsScreen({ agentId }: { agentId?: string }) {
  const m = useWorkspaceModel();
  const list = agentId ? m.agents.filter(a => a.key === agentId) : m.agents;
  return <div className="space-y-4"><PageTitle title="AI 팀" subtitle="ON/OFF와 배정·증거·상태" />{!agentId && <><OrchUsagePanel /><OrchSwitchesPanel /></>}<SourceBanner m={m} />
    {agentId && <Link href="/agents" className="inline-flex min-h-11 items-center text-accent">← AI 팀</Link>}
    {agentId && !list.length && <Card><p>에이전트 정보를 찾지 못했습니다.</p></Card>}
    {list.map(a => <Card key={a.key}><div className="flex items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">{a.name}</h2><p className="text-sm text-text-muted">{a.role}</p></div>
      <span data-testid={`agent-${a.key}-state`} className="rounded-full bg-slate-700 px-3 py-1 text-xs">{a.control.alwaysOn ? "항상 ON" : a.control.enabled === "unknown" ? "ON/OFF 확인 불가" : a.control.enabled ? "ON" : "OFF"}</span></div>
      <p className="mt-2 text-xs text-text-faint">{a.control.note}</p>
      <div className="mt-3 space-y-1 text-sm"><p>사용량 · 확인 불가 (측정 원천 없음)</p><p>실행 상태 · 확인되지 않음{a.recordedRuns === "unknown" ? "" : ` (내부 기록 ${a.recordedRuns}건)`}</p>
        <p>최근 증거 · {a.lastEvidenceAt ? when(a.lastEvidenceAt) : "없음"}</p>
        {a.key !== "gpt" && a.control.effective !== "unknown" && <p>새 업무 배정 · {a.control.effective ? "가능" : "제한됨"}</p>}</div>
      <ul className="mt-3 space-y-1 text-xs">{a.assignments.map(x => <li key={x.taskId} className="break-words">#{x.taskId} {x.title} · {x.phaseLabel}</li>)}{!a.assignments.length && <li className="text-text-faint">확인된 배정 없음</li>}</ul>
      {!agentId && <Link href={`/agents/${a.key}`} className="mt-2 inline-flex min-h-11 items-center text-accent">상세 →</Link>}</Card>)}</div>;
}
export function LiveBriefingScreen() {
  return <div className="space-y-4"><PageTitle title="PM 브리핑" subtitle="결정·승인·사건·다음 단계" /><OrchDecisionsPanel /></div>;
}
