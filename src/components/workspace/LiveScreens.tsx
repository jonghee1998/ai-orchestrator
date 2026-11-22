"use client";
// Issue #116 / T2 — live read-only mobile tabs on WorkspaceModel v1. No mutation controls; demo simulation stays separate.
import Link from "next/link";
import { Card, PageTitle } from "@/components/ui";
import { CURRENT_VERSION, PATCH_NOTES } from "@/lib/patchnotes";
import { formatKstDate } from "@/lib/time/kst";
import { BackIcon } from "@/components/icons";
import { Account } from "./Account";
import { OrchIdeasPanel } from "@/components/orch/IdeasPanel";
import { OrchDecisionsPanel, OrchPlansPanel, OrchRunsPanel, OrchSwitchesPanel, OrchUsagePanel } from "@/components/orch/OrchPanels";

export function LiveProjectsScreen({ projectId }: { projectId?: string; taskId?: string }) {
  if (projectId) return <div className="space-y-4"><Link href="/projects" className="inline-flex min-h-11 items-center gap-1 text-accent"><BackIcon />프로젝트</Link><Card><p>프로젝트 상세는 자동 진행 작업으로 통합되었습니다</p></Card><Account /></div>;
  const pmChatUrl = process.env.NEXT_PUBLIC_PM_CHAT_URL || "https://claude.ai";
  return <div className="space-y-4"><OrchRunsPanel pmChatUrl={pmChatUrl} /><Account /></div>;
}
export function LiveAgentsScreen({ agentId }: { agentId?: string }) {
  if (agentId) return <div className="space-y-4"><Link href="/agents" className="inline-flex min-h-11 items-center gap-1 text-accent"><BackIcon />AI 팀</Link><Card><p>AI 상세는 AI 팀 화면으로 통합되었습니다</p></Card><Account /></div>;
  return <div className="space-y-4"><PageTitle title="AI 팀" subtitle="AI 사용량과 ON/OFF" /><OrchUsagePanel /><OrchSwitchesPanel /><Account /></div>;
}
export function LiveBriefingScreen() {
  return <div className="space-y-4"><PageTitle title="PM 브리핑" subtitle="결정·승인·사건·다음 단계" /><OrchPlansPanel /><OrchIdeasPanel /><OrchDecisionsPanel /></div>;
}
export function LivePatchNotesScreen() {
  return (
    <div className="space-y-4">
      <PageTitle title="패치노트" subtitle={"현재 버전 v" + CURRENT_VERSION} />
      <Card className="py-2">
        <ol aria-label="패치노트 목록">
          {PATCH_NOTES.map((n, i) => (
            <li key={n.version} className={`py-3.5 ${i ? "border-t border-border" : ""}`}>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px] tabular-nums">
                <span className="font-bold">v{n.version}</span>
                <span className="text-text-muted">{formatKstDate(n.date)}</span>
                {n.pr !== undefined && (
                  <a href={`https://github.com/jonghee1998/ai-orchestrator/pull/${n.pr}`} target="_blank" rel="noreferrer" className="-my-3 ml-auto inline-flex min-h-11 items-center font-semibold text-accent">PR #{n.pr}</a>
                )}
              </div>
              <p className="mt-1 break-words text-[15px] font-bold tracking-[-0.02em]">{n.title}</p>
              <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[13px] text-text-muted marker:text-text-faint">
                {n.items.map((it) => <li key={it} className="break-words">{it}</li>)}
              </ul>
            </li>
          ))}
        </ol>
      </Card>
      <p className="px-1 text-[11px] text-text-muted">버전 규칙: 사소한 수정 +0.0.1 · 큰 변화 +0.1 · 아주 큰 변화 +1 (v1.0.0 = 엔진 도입)</p>
    </div>
  );
}
