"use client";
// Issue #116 / T2 — live read-only mobile tabs on WorkspaceModel v1. No mutation controls; demo simulation stays separate.
import Link from "next/link";
import { Card, PageTitle } from "@/components/ui";
import { formatKst } from "@/lib/time/kst";
import { useWorkspaceModel } from "./useWorkspace";
import { Account } from "./Account";
import { OrchDecisionsPanel, OrchRunsPanel, OrchSwitchesPanel, OrchUsagePanel } from "@/components/orch/OrchPanels";
import { matchRouteId } from "@/lib/workspace/route";
import { PART_LABEL, type BriefingItem, type ModelProject, type ModelTask, type PartState, type WorkspaceModelV1 } from "@/lib/workspace/model";

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
const Unconnected = ({ m, what }: { m: WorkspaceModelV1; what: string }) => <Card><p data-testid="unconnected">{m.source === "loading" ? "불러오는 중입니다." : `${what}을(를) 표시할 수 없습니다. 작업 큐가 연결되지 않았습니다. 확인되지 않은 값은 만들지 않습니다.`}</p></Card>;

function TaskLine({ t, projectId }: { t: ModelTask; projectId: string }) {
  return <Link href={`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(t.id)}`} className="block rounded-xl border border-border bg-bg-raised p-3">
    <p className="break-words text-sm font-medium">#{t.id} {t.title}</p>
    <p className="mt-1 text-xs text-text-muted">{t.agentName} · {t.phaseLabel}</p>
    <p className="text-xs text-text-faint">{t.completionLabel}{t.selfReportedOnly ? " · 공식 승인 없음(자기보고 수락 또는 종료 기준)" : ""}</p>
  </Link>;
}
function ProjectCard({ p }: { p: ModelProject }) {
  return <Link href={`/projects/${encodeURIComponent(p.id)}`} className="block"><Card>
    <h2 className="break-words text-lg font-semibold">{p.name}</h2>
    <p className="mt-1 text-xs text-text-muted">{p.goal ?? "목표 미확인"}</p>
    <p className="mt-2 text-sm">{p.stage}</p>
    <p className="mt-1 text-xs text-text-muted">완료 {p.counts.completed} / 전체 {p.counts.total} · 남은 {p.counts.remaining}{p.counts.unknown ? ` · 확인 불가 ${p.counts.unknown}` : ""}</p>
  </Card></Link>;
}
function ProjectDetail({ p }: { p: ModelProject }) {
  return <div className="space-y-4">
    <Link href="/projects" className="inline-flex min-h-11 items-center text-accent">← 프로젝트</Link>
    <PageTitle title={p.name} subtitle={p.goal ?? "목표 미확인"} />
    <Card><p>{p.stage}</p><p className="mt-1 text-xs text-text-muted">완료 {p.counts.completed} · 남은 {p.counts.remaining} · 진행 {p.counts.active} · 접수 보고 {p.counts.reported}</p>
      {p.counts.completedWithoutOfficialReview > 0 && <p className="mt-1 text-xs text-yellow-100">완료 중 {p.counts.completedWithoutOfficialReview}건은 공식 GitHub 승인 없이 기준만 충족했습니다.</p>}</Card>
    <section aria-label="남은 업무" className="space-y-2"><h2 className="text-sm font-semibold text-text-muted">남은 업무 · {p.remaining.length}</h2>{p.remaining.map(t => <TaskLine key={t.id} t={t} projectId={p.id} />)}{!p.remaining.length && <p className="text-sm text-text-faint">남은 업무 없음</p>}</section>
    <section aria-label="완료 업무" className="space-y-2"><h2 className="text-sm font-semibold text-text-muted">완료 업무 · {p.completed.length}</h2>{p.completed.map(t => <TaskLine key={t.id} t={t} projectId={p.id} />)}{!p.completed.length && <p className="text-sm text-text-faint">완료 기준을 충족한 업무 없음</p>}</section>
    <section aria-label="이력" className="space-y-1"><h2 className="text-sm font-semibold text-text-muted">이력 · {p.history.length}</h2>
      {p.history.slice(0, 30).map(h => <p key={h.id} className="break-words text-xs">{when(h.at)} · #{h.taskId} · {h.actor} · {h.change} <span className="text-text-faint">({h.source})</span></p>)}
      {!p.history.length && <p className="text-sm text-text-faint">확인된 이력 없음</p>}</section>
  </div>;
}
function TaskDetail({ p, t }: { p: ModelProject; t?: ModelTask }) {
  if (!t) return <div className="space-y-3"><Link href={`/projects/${encodeURIComponent(p.id)}`} className="inline-flex min-h-11 items-center text-accent">← {p.name}</Link><Card><p>업무를 찾지 못했습니다.</p></Card></div>;
  return <div className="space-y-4"><Link href={`/projects/${encodeURIComponent(p.id)}`} className="inline-flex min-h-11 items-center text-accent">← {p.name}</Link>
    <PageTitle title={`#${t.id} ${t.title}`} subtitle={`${t.agentName} · ${t.phaseLabel}`} />
    <Card><p>{t.completionLabel}</p><p className="mt-1 text-sm">다음 · {t.next}</p><p className="text-sm">대기 · {t.waiting || "없음"}</p>
      {t.missing.length > 0 && <p className="mt-1 text-xs text-text-muted">부족한 증거 · {t.missing.join(", ")}</p>}
      {t.url && <a href={t.url} target="_blank" rel="noreferrer" className="mt-2 inline-flex min-h-11 items-center text-accent">GitHub에서 열기</a>}</Card>
    <section aria-label="이력" className="space-y-1">{p.history.filter(h => h.taskId === t.id).map(h => <p key={h.id} className="break-words text-xs">{when(h.at)} · {h.actor} · {h.change} ({h.source})</p>)}</section></div>;
}
export function LiveProjectsScreen({ projectId, taskId }: { projectId?: string; taskId?: string }) {
  const m = useWorkspaceModel();
  const p = projectId ? matchRouteId(m.projects, projectId) : undefined;
  if (projectId && p) return <div className="space-y-4"><SourceBanner m={m} />{taskId ? <TaskDetail p={p} t={matchRouteId(p.tasks, taskId)} /> : <ProjectDetail p={p} />}<Account /></div>;
  return <div className="space-y-4"><PageTitle title="AI Orchestrator" subtitle="실제 GitHub 기록 기준" /><OrchRunsPanel /><SourceBanner m={m} />
    {m.source === "unconnected" || m.source === "loading" ? <Unconnected m={m} what="프로젝트" /> : projectId ? <Card><p>프로젝트를 찾지 못했습니다.</p></Card> : <>
      <div className="grid grid-cols-2 gap-3"><Card><p className="text-xs text-text-muted">전체 프로젝트</p><p className="mt-1 text-2xl font-semibold">{m.projects.length}</p></Card><Card><p className="text-xs text-text-muted">완료 기준 충족 업무</p><p className="mt-1 text-2xl font-semibold">{m.projects.reduce((n, x) => n + x.counts.completed, 0)}</p></Card></div>
      {m.projects.map(x => <ProjectCard key={x.id} p={x} />)}{!m.projects.length && <Card><p>확인된 프로젝트가 없습니다.</p></Card>}</>}<Account /></div>;
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
function Group({ title, items }: { title: string; items: BriefingItem[] }) {
  return <section aria-label={title} className="space-y-2"><h2 className="text-sm font-semibold text-text-muted">{title} · {items.length}</h2>
    {items.map(i => <Card key={i.id}><p className="break-words font-medium">{i.title}</p><p className="mt-1 break-words text-sm">{i.detail}</p><p className="mt-1 text-xs text-text-faint">{i.evidence}{i.at ? ` · ${when(i.at)}` : ""}</p>{i.url && <a href={i.url} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center text-accent">GitHub에서 열기</a>}</Card>)}
    {!items.length && <p className="text-sm text-text-faint">없음</p>}</section>;
}
export function LiveBriefingScreen() {
  const m = useWorkspaceModel();
  return <div className="space-y-4"><PageTitle title="PM 브리핑" subtitle="결정·승인·사건·다음 단계" /><OrchDecisionsPanel /><SourceBanner m={m} />
    {m.source === "unconnected" || m.source === "loading" ? <Unconnected m={m} what="브리핑" /> : <><Group title="결정 필요" items={m.briefing.decisions} /><Group title="승인 기록" items={m.briefing.approvals} /><Group title="사건·한계" items={m.briefing.incidents} /><Group title="다음 단계" items={m.briefing.next} /></>}</div>;
}
