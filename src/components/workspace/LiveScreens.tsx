"use client";
// Issue #116 / T2 — live read-only mobile tabs on WorkspaceModel v1. No mutation controls; demo simulation stays separate.
import Link from "next/link";
import { Card, PageTitle } from "@/components/ui";
import { formatKst } from "@/lib/time/kst";
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
  if (agentId) return <div className="space-y-4"><Link href="/agents" className="inline-flex min-h-11 items-center text-accent">← AI 팀</Link><Card><p>AI 상세는 AI 팀 화면으로 통합되었습니다</p></Card><Account /></div>;
  return <div className="space-y-4"><PageTitle title="AI 팀" subtitle="AI 사용량과 ON/OFF" /><OrchUsagePanel /><OrchSwitchesPanel /><Account /></div>;
}
export function LiveBriefingScreen() {
  return <div className="space-y-4"><PageTitle title="PM 브리핑" subtitle="결정·승인·사건·다음 단계" /><OrchDecisionsPanel /></div>;
}
