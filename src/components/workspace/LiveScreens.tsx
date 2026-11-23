"use client";
// Issue #116 / T2 — live read-only mobile tabs on WorkspaceModel v1. No mutation controls; demo simulation stays separate.
import Link from "next/link";
import { Card, PageTitle } from "@/components/ui";
import { PATCH_NOTES, groupByMajor, type PatchNote } from "@/lib/patchnotes";
import { formatKstDate } from "@/lib/time/kst";
import { BackIcon, ChevronIcon } from "@/components/icons";
import { Account } from "./Account";
import { OrchIdeasPanel } from "@/components/orch/IdeasPanel";
import { OrchDecisionsPanel, OrchPlansPanel, OrchRunsPanel, OrchSwitchesPanel, OrchUsagePanel, useOrch } from "@/components/orch/OrchPanels";
import { SELF_REPO } from "@/lib/orch/model";
import { useState } from "react";

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
function NoteItem({ n, first, repo }: { n: PatchNote; first: boolean; repo: string }) {
  return (
    <li className={`py-3.5 ${first ? "" : "border-t border-border"}`}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px] tabular-nums">
        <span className="font-bold">v{n.version}</span>
        <span className="text-text-muted">{formatKstDate(n.date)}</span>
        {n.pr !== undefined && (
          <a href={`https://github.com/${repo}/pull/${n.pr}`} target="_blank" rel="noreferrer" className="-my-3 ml-auto inline-flex min-h-11 items-center font-semibold text-accent">PR #{n.pr}</a>
        )}
      </div>
      <p className="mt-1 break-words text-[15px] font-bold tracking-[-0.02em]">{n.title}</p>
      <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[13px] text-text-muted marker:text-text-faint">
        {n.items.map((it) => <li key={it} className="break-words">{it}</li>)}
      </ul>
    </li>
  );
}

const shortRepo = (r: string) => r.split("/").pop() ?? r;

/** 패치노트 탭: 프로젝트를 고르고(이 상황판 + docs/patchnotes.json 이 있는 다른 저장소), 큰 버전(1.x, 2.x)마다 접고 펼침. */
export function LivePatchNotesScreen() {
  const { state } = useOrch();
  const others = state.kind === "ok" ? state.data.repos.filter((r) => r.repo !== SELF_REPO && (r.patchNotes?.length ?? 0) > 0) : [];
  const errors = state.kind === "ok" ? state.data.repos.filter((r) => r.repo !== SELF_REPO && r.patchNotesError) : [];
  const projects: { repo: string; notes: PatchNote[] }[] = [{ repo: SELF_REPO, notes: PATCH_NOTES }, ...others.map((r) => ({ repo: r.repo, notes: r.patchNotes! }))];
  const [pick, setPick] = useState(SELF_REPO);
  const cur = projects.find((p) => p.repo === pick) ?? projects[0];
  const groups = groupByMajor(cur.notes);
  return (
    <div className="space-y-4">
      <PageTitle title="패치노트" subtitle={`${shortRepo(cur.repo)} · 현재 버전 v${cur.notes[0].version}`} />
      <div className="flex flex-wrap gap-2" role="group" aria-label="프로젝트" data-testid="patch-projects">
        {projects.map((p) => {
          const on = p.repo === cur.repo;
          return (
            <button key={p.repo} type="button" aria-pressed={on} onClick={() => setPick(p.repo)}
              className={`min-h-11 rounded-full px-3.5 text-[13px] ${on ? "bg-text font-semibold text-white" : "bg-bg-card text-text-muted shadow-[0_1px_2px_rgba(17,20,24,.06)]"}`}>
              {shortRepo(p.repo)} <span className="tabular-nums opacity-70">v{p.notes[0].version}</span>
            </button>
          );
        })}
      </div>
      {errors.map((r) => <p key={r.repo} className="px-1 text-xs text-danger">{shortRepo(r.repo)} 패치노트 읽기 실패 · {r.patchNotesError}</p>)}
      {groups.map((g, gi) => {
        const newest = g.notes[0].version;
        const oldest = g.notes[g.notes.length - 1].version;
        return (
          <details key={`${cur.repo}-${g.major}`} open={gi === 0} className="rounded-[18px] bg-bg-card px-4 shadow-[0_1px_2px_rgba(17,20,24,.04),0_4px_16px_rgba(17,20,24,.04)]" data-testid={`patch-major-${g.major}`}>
            <summary className="flex min-h-14 cursor-pointer items-center gap-2">
              <span className="text-lg font-[750] tracking-[-0.02em]">v{g.major}.x</span>
              <span className="text-xs tabular-nums text-text-muted">v{oldest} ~ v{newest} · {g.notes.length}개</span>
              <ChevronIcon className="ml-auto h-4 w-4" />
            </summary>
            <ol aria-label={`v${g.major}.x 패치노트`} className="border-t border-border">
              {g.notes.map((n, i) => <NoteItem key={n.version} n={n} first={i === 0} repo={cur.repo} />)}
            </ol>
          </details>
        );
      })}
      <p className="px-1 text-[11px] text-text-muted">버전 규칙: 사소한 수정 +0.0.1 · 큰 변화 +0.1 · 아주 큰 변화 +1. 다른 프로젝트는 저장소의 docs/patchnotes.json 을 읽습니다.</p>
    </div>
  );
}
