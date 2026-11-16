"use client";
import Link from "next/link";
import { Card, PageTitle } from "@/components/ui";
import { LoginCard } from "@/components/LoginCard";
import { useSession } from "@/components/live/session";
import { LiveStatus } from "@/components/live/LiveStatus";
import { useWorkspace } from "./useWorkspace";
import { useDemo } from "./DemoContext";
import { AI_NAMES, PHASE_LABEL, projectHref, taskHref, type Project, type Work, type WorkEvent } from "@/lib/github/mobile-workspace";
import { formatKst } from "@/lib/time/kst";
import ControlDashboard from "@/components/control/ControlDashboard";
import OverviewDashboard from "@/components/overview/OverviewDashboard";
import { ProgressDashboard } from "@/components/progress/ProgressDashboard";
import { WorkQueueDashboard } from "@/components/work-queue/WorkQueueDashboard";
import TechnicalEvidence from "./TechnicalEvidence";
const clean = (s: string) => s.replace(/^\[DEMO\]\s*/, "");
const external = (url?: string) => !!url && /^https:\/\/github\.com\//.test(url);
function Badge({ task }: { task: Work }) { return <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs ${task.phase === "done" ? "bg-ok/15 text-ok" : task.phase === "blocked" ? "bg-danger/15 text-red-200" : "bg-accent/15 text-blue-200"}`}>{PHASE_LABEL[task.phase]}</span>; }
function TaskCard({ task }: { task: Work }) {
  return <Link href={taskHref(task)} className="block rounded-xl border border-border bg-bg-card p-4 hover:border-accent" data-testid={`task-${task.id}`}>
    <p className="mb-2 text-base font-semibold leading-relaxed">{clean(task.title)}</p><div className="flex flex-wrap items-center gap-2 text-sm"><span>{AI_NAMES[task.agent] ?? task.agent}</span><Badge task={task} /></div>
    <p className="mt-3 text-sm text-text-muted">다음 할 일 · {task.next}</p><p className="mt-1 text-xs text-text-faint">{task.waiting}</p>
  </Link>;
}
function ProjectCard({ project: p }: { project: Project }) {
  return <Link href={projectHref(p.id)} className="block rounded-xl border border-border bg-bg-card p-4 hover:border-accent" data-testid={`project-${p.id}`}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-base font-semibold">{p.name}</h3><span className="text-xs text-blue-200">{p.stage} →</span></div>
    <p className="mt-2 text-sm text-text-muted">목표 · {p.goal || "등록된 목표가 없습니다"}</p>
    <dl className="mt-4 grid grid-cols-3 gap-2 text-center text-sm"><div><dt className="text-text-muted">완료한 일</dt><dd className="mt-1 text-lg font-semibold">{p.done}건</dd></div><div><dt className="text-text-muted">진행·검수</dt><dd className="mt-1 text-lg font-semibold">{p.active}건</dd></div><div><dt className="text-text-muted">남은 일</dt><dd className="mt-1 text-lg font-semibold">{p.remaining}건</dd></div></dl>
    <p className="mt-3 text-xs text-text-faint">전체 {p.tasks.length}건 중 업무 종료 {p.done}건 · 남은 일에는 진행·검수 중인 일도 포함</p>
  </Link>;
}
function Account() {
  const s = useSession();
  return <details open={s.status !== "authed"} className="rounded-xl border border-border"><summary className="cursor-pointer px-4 py-3 text-sm">계정 · {s.status === "authed" ? "로그인됨 · 만료 및 로그아웃" : "로그인"}</summary><div className="p-2"><LoginCard /></div></details>;
}
function Section({ title, children }: { title: string; children: React.ReactNode }) { return <section aria-label={title} className="space-y-3"><h2 className="text-base font-semibold">{title}</h2>{children}</section>; }
function Status({ w }: { w: ReturnType<typeof useWorkspace> }) {
  const { info } = useDemo();
  return <><LiveStatus s={w.queue.state} reload={w.queue.reload} what="프로젝트와 작업" error={w.queue.error} />
    {w.report?.limits.issuesTruncated && <p role="note" className="text-sm text-warn">일부 작업만 조회했습니다. 전체 현황과 다를 수 있습니다.</p>}
    {info.demo === true && <p className="text-xs text-text-faint">샘플 데이터 기준 · {formatKst(w.snapshot?.generatedAt, "아직 불러오지 못함")} · 화면 갱신 시각은 상단에 별도 표시</p>}
  </>;
}
function Events({ events, limit }: { events: WorkEvent[]; limit?: number }) {
  const { info } = useDemo();
  return <ol className="space-y-3">{events.slice(0, limit).map(e => <li key={e.id}><Card><p className="text-base font-semibold">{clean(e.title)}</p><p className="mt-1 text-sm">{e.change}</p><p className="mt-2 text-xs text-text-muted">{e.actor} · {formatKst(e.at)}</p><p className="mt-1 text-xs text-text-faint">출처 · {info.demo === true ? `합성 샘플 (${e.source})` : e.source}</p><details className="mt-2 text-xs text-text-muted"><summary className="cursor-pointer py-3">원문 및 출처</summary><p>{e.raw}</p>{external(e.url) && <a className="inline-flex min-h-11 items-center text-accent" href={e.url} target="_blank" rel="noreferrer">출처 자료 열기 ↗</a>}</details></Card></li>)}</ol>;
}
export function HomeScreen() {
  const w = useWorkspace();
  const needs = w.tasks.filter(t => t.phase === "review" || t.phase === "blocked");
  return <div className="space-y-6"><PageTitle title="홈" subtitle="프로젝트와 다음 할 일을 한눈에 확인하세요" /><Status w={w} />
    {w.queue.state.kind === "ok" && <>
      <Section title="내 확인 필요">{needs.length ? needs.slice(0, 3).map(t => <TaskCard key={t.id} task={t} />) : <Card><p>확인할 일이 없습니다</p></Card>}</Section>
      <Section title="프로젝트 현황">{w.projects.map(p => <ProjectCard key={p.id} project={p} />)}{!w.projects.length && <Card><p>등록된 프로젝트와 작업이 없습니다</p></Card>}</Section>
      <Section title="AI가 진행 중인 일">{w.tasks.filter(t => t.phase === "active").map(t => <TaskCard key={t.id} task={t} />)}{!w.tasks.some(t => t.phase === "active") && <Card><p>진행 중으로 확인된 일이 없습니다</p></Card>}</Section>
    </>}
    <Section title="최근 활동"><LiveStatus s={w.evidence.state} reload={w.evidence.reload} what="작업 소식" error={w.evidence.error} /><Events events={w.events} limit={5} />{!w.events.length && w.evidence.state.kind === "ok" && <p className="text-sm text-text-muted">아직 기록된 활동이 없습니다</p>}<Link className="inline-flex min-h-11 items-center text-sm text-accent" href="/activity">전체 활동 보기 →</Link></Section>
    <Account />
    <details className="rounded-xl border border-border p-4"><summary className="cursor-pointer text-sm">연결 설정 및 시스템 상세</summary><OverviewDashboard embedded /></details>
  </div>;
}
export function ProjectsScreen({ projectId, taskId }: { projectId?: string; taskId?: string }) {
  const w = useWorkspace();
  const p = w.projects.find(p => p.id === projectId);
  const task = p?.tasks.find(t => t.id === taskId);
  if (taskId) return <TaskScreen task={task} project={p} w={w} />;
  return <div className="space-y-5"><PageTitle title={projectId ? p?.name ?? "프로젝트 상세" : "프로젝트"} subtitle={projectId ? p?.goal ?? "등록된 목표가 없습니다" : "프로젝트를 선택해 완료한 일과 남은 일을 확인하세요"} />
    {projectId && <Link href="/projects" className="inline-flex min-h-11 items-center text-sm text-accent">← 프로젝트 목록</Link>}<Status w={w} />
    {!projectId && w.projects.map(p => <ProjectCard key={p.id} project={p} />)}
    {!projectId && w.queue.state.kind === "ok" && !w.projects.length && <Card><p>등록된 프로젝트와 작업이 없습니다</p></Card>}
    {p && <><ProjectCard project={p} />{([
      ["완료한 일", p.tasks.filter(t => t.phase === "done")], ["진행 중인 일", p.tasks.filter(t => t.phase === "active")],
      ["남은 일", p.tasks.filter(t => ["remaining", "blocked", "unknown"].includes(t.phase))], ["내 확인 필요", p.tasks.filter(t => t.phase === "review" || t.phase === "blocked")],
    ] as [string, Work[]][]).map(([label, tasks]) => <Section title={label} key={label}>{tasks.length ? tasks.map(t => <TaskCard key={t.id} task={t} />) : <p className="text-sm text-text-muted">해당하는 일이 없습니다</p>}</Section>)}</>}
    {projectId && !p && w.queue.state.kind === "ok" && <p>현재 조회 범위에서 프로젝트를 찾지 못했습니다.</p>}
    <details id="work-details" className="rounded-xl border border-border p-4"><summary className="cursor-pointer text-sm">작업 진행·대기 목록의 상세 기록</summary><ProgressDashboard /><WorkQueueDashboard /></details>
    <details id="results" className="rounded-xl border border-border p-4"><summary className="cursor-pointer text-sm">결과 자료와 검수 원문 전체 보기</summary><TechnicalEvidence /></details>
  </div>;
}
function TaskScreen({ task: t, project: p, w }: { task?: Work; project?: Project; w: ReturnType<typeof useWorkspace> }) {
  const record = w.snapshot?.runs.find(r => String(r.issueNumber) === t?.id);
  const steps: [string, boolean][] = [["전달", !!record?.requestedAt], ["수신 확인", !!t?.proof?.acks.length || !!record?.ackAt], ["개발", t?.phase === "active" || !!record?.startedAt], ["검수", t?.phase === "review" || !!t?.proof?.pulls.some(p => p.reviews.length)], ["완료", t?.phase === "done"]];
  return <div className="space-y-5"><Link className="inline-flex min-h-11 items-center text-sm text-accent" href={p ? projectHref(p.id) : "/projects"}>← 프로젝트로</Link><Status w={w} />{t ? <>
    <PageTitle title={clean(t.title)} subtitle={`${p?.name} · ${AI_NAMES[t.agent]}`} /><Badge task={t} />
    <Section title="작업 목표 및 요구사항"><Card><p className="whitespace-pre-wrap text-sm leading-relaxed">{t.description || "등록된 상세 요구사항이 없습니다. 출처 자료를 확인해 주세요."}</p></Card></Section>
    <Section title="진행 단계"><ol className="grid grid-cols-5 gap-1">{steps.map(([name, confirmed]) => <li className={`rounded-lg p-2 text-center text-xs ${confirmed ? "bg-accent/20 text-blue-200" : "bg-bg-card text-text-muted"}`} key={name}><p>{name}</p><p className="mt-2">{confirmed ? "확인" : "미확인"}</p></li>)}</ol><p className="text-xs text-text-faint">확인된 단계만 표시합니다. 개발 완료 보고, 검수 통과, 배포 완료는 서로 다릅니다.</p></Section>
    <Section title="현재 상황 및 다음 할 일"><Card><p>{PHASE_LABEL[t.phase]}</p><p className="mt-2 text-sm">{t.next}</p><p className="mt-2 text-sm text-text-muted">{t.waiting}</p></Card></Section>
    <Section title="결과 및 검수 자료">{t.proof?.completions.map(c => <Card key={c.id}><p className="text-sm">개발 완료 보고 · 검수·배포 완료와 별개</p><p className="mt-2 text-xs text-text-muted">{formatKst(c.at)} · GitHub 자기보고</p></Card>)}
      {t.proof?.pulls.map(p => <Card key={p.number}><p>결과 제안 #{p.number} · {p.state === "merged" ? "병합됨 · 배포는 확인 필요" : "검수 결과 확인 필요"}</p><p className="mt-2 text-sm">검수 {p.reviews.length}건 · 판정 {p.decision?.kind ?? "확인되지 않음"}</p>{!external(p.url) && <p className="mt-2 text-xs text-text-muted">샘플 결과 제안(PR) · 실제 연결 없음</p>}{external(p.url) && <a href={p.url} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center text-accent">결과 자료 열기 ↗</a>}</Card>)}
      {record?.execution?.tests.map((test, index) => <Card key={index}><p className="text-sm">테스트 {test.exitCode === 0 ? "통과 보고" : "실패 보고"} · 실행자 제공 기록</p><code className="mt-2 block break-all text-xs text-text-muted">{test.command}</code></Card>)}
      {!t.proof?.pulls.length && <p className="text-sm text-text-muted">연결된 결과 제안이나 테스트 자료가 없습니다. 완료를 추정하지 않습니다.</p>}
      {external(t.url) && <a href={t.url} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center text-accent">작업 출처 열기 ↗</a>}
    </Section>
    <details className="rounded-xl border border-border p-4"><summary className="cursor-pointer text-sm">상세 기술 기록</summary><pre className="mt-3 whitespace-pre-wrap break-all text-xs text-text-muted">{JSON.stringify({ task: t, record }, null, 2)}</pre></details>
  </> : w.queue.state.kind === "ok" && <p>현재 조회 범위에서 작업을 찾지 못했습니다.</p>}</div>;
}
export function AgentsScreen() {
  const w = useWorkspace();
  const { info, loaded } = useDemo();
  const keys = [...new Set(["gpt", "claude-sonnet", "claude-opus", "codex", ...(w.snapshot?.agents.map(a => a.key) ?? [])])];
  return <div className="space-y-5"><PageTitle title="에이전트" subtitle="누가 어떤 일을 맡고 있는지 확인하세요" /><Status w={w} /><LiveStatus s={w.runtime.state} reload={w.runtime.reload} what="배정 설정과 실행 기록" error={w.runtime.error} />
    {keys.map(key => { const a = w.snapshot?.agents.find(a => a.key === key); const tasks = w.tasks.filter(t => (t.agent === "claude" ? "claude-sonnet" : t.agent === "opus" ? "claude-opus" : t.agent) === key && t.phase !== "done");
      return <section key={key} aria-label={AI_NAMES[key] ?? key}><Card><h2 className="text-lg font-semibold">{AI_NAMES[key] ?? key}</h2><p className="mt-2 text-sm">새 작업 배정 · {a ? a.effective ? "가능" : "일시정지 또는 조건 확인 필요" : "확인되지 않음"}</p>
        <p className="mt-1 text-sm">현재 실행 · {a ? `내부 기록상 진행 중 ${a.running}건, 시작 대기 ${a.queued}건, 보류 ${a.held}건` : "실행 기록을 확인하지 못했습니다"}</p><p className="mt-1 text-xs text-text-faint">배정 가능 상태가 실제 실행 중이라는 뜻은 아닙니다{info.demo === true ? " · 샘플 정책이며 실제 연결 상태가 아닙니다" : ""}.</p>
        <p className="mt-3 text-sm">담당 프로젝트 · {[...new Set(tasks.map(t => t.project?.name ?? "미분류"))].join(", ") || "확인된 담당 프로젝트 없음"}</p>
        <p className="mt-1 text-xs text-text-muted">최근 응답 · {formatKst(a?.lastHeartbeat ?? a?.lastAck, "확인되지 않음")}</p>
        <a href="#assignment-settings" className="inline-flex min-h-11 items-center text-sm text-accent">배정 설정 확인 ↓</a><div className="mt-3 space-y-3">{tasks.map(t => <TaskCard key={t.id} task={t} />)}{!tasks.length && <p className="text-sm text-text-muted">현재 맡은 것으로 확인된 일이 없습니다</p>}</div>
      </Card></section>;
    })}
    <details id="assignment-settings" className="rounded-xl border border-border p-4"><summary className="cursor-pointer text-base font-semibold">에이전트 상세 · 배정 설정</summary><p className="my-3 text-sm text-warn">이곳에서 일시정지해도 외부에서 시작한 작업은 실행될 수 있습니다.</p>{info.demo === true && <p className="my-3 text-sm">샘플 배정 정책입니다. 설정을 변경하거나 실제 AI를 호출하지 않습니다.</p>}<ControlDashboard embedded readOnly={!loaded || info.demo !== false} /></details>
  </div>;
}
export function ActivityScreen() {
  const w = useWorkspace();
  return <div className="space-y-5"><PageTitle title="활동" subtitle="작업 배정부터 결과 확인까지, 최근 소식을 시간순으로 확인하세요" /><Status w={w} /><LiveStatus s={w.evidence.state} reload={w.evidence.reload} what="작업 소식" error={w.evidence.error} /><LiveStatus s={w.runtime.state} reload={w.runtime.reload} what="실행·설정 기록" error={w.runtime.error} /><p className="text-xs text-text-muted">GitHub 자기보고와 내부 실행 기록은 별도 출처입니다. 같은 내용이 각 출처에 기록되어도 실행 횟수를 합산하지 않습니다.</p><Events events={w.events} />{!w.events.length && w.evidence.state.kind === "ok" && w.runtime.state.kind === "ok" && <Card><p>아직 기록된 활동이 없습니다</p></Card>}</div>;
}
