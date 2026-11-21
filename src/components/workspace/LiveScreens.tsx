"use client";
// Issue #116 / T2 — live read-only mobile tabs on WorkspaceModel v1. No mutation controls; demo simulation stays separate.
import Link from "next/link";
import { Card, PageTitle } from "@/components/ui";
import { CURRENT_VERSION, PATCH_NOTES } from "@/lib/patchnotes";
import { Account } from "./Account";
import { OrchDecisionsPanel, OrchRunsPanel, OrchSwitchesPanel, OrchUsagePanel } from "@/components/orch/OrchPanels";

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
export function LivePatchNotesScreen() {
  return (
    <div className="space-y-4">
      <PageTitle title="패치노트" subtitle={"현재 버전 v" + CURRENT_VERSION} />
      {PATCH_NOTES.map((n) => (
        <Card key={n.version}>
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
            <span className="font-semibold text-accent">v{n.version}</span>
            <span className="text-text-faint">{n.date}</span>
            {n.pr !== undefined && (
              <a href={`https://github.com/jonghee1998/ai-orchestrator/pull/${n.pr}`} target="_blank" rel="noreferrer" className="text-accent">PR #{n.pr}</a>
            )}
          </div>
          <p className="mt-1 break-words font-medium">{n.title}</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-text-muted">
            {n.items.map((it) => <li key={it} className="break-words">{it}</li>)}
          </ul>
        </Card>
      ))}
      <p className="text-[11px] text-text-faint">버전 규칙: 사소한 수정 +0.0.1 · 큰 변화 +0.1 · 아주 큰 변화 +1 (v1.0.0 = 엔진 도입)</p>
    </div>
  );
}
