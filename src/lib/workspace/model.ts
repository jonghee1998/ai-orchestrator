// WorkspaceModel v1 (Issue #116 / T2): one read-only presentation model for the three mobile tabs
// (Projects / AI Team / PM Briefing), built ONLY from actual GitHub + runtime evidence.
// Rules: never fabricate usage, running state, goals or completion. Missing evidence stays unknown/unconnected/partial.
// Display only: nothing here authorizes execution, merge or deploy (see Lifecycle.authorizesExecution).
import type { WorkQueueTask } from "../github/work-queue";
import type { EvidenceReport } from "../github/evidence-types";
import { githubActivity } from "../github/evidence-views";
import { AI_NAMES, workspace, phaseLabel, type Project, type Runtime, type Work } from "../github/mobile-workspace";
import { COMPLETION_LABEL } from "../workflow/lifecycle";
import type { Live } from "../refresh/live-loader";

export type PartState = "ok" | "loading" | "unconfigured" | "unauthenticated" | "error";
export type PartKey = "queue" | "evidence" | "runtime";
export const PART_LABEL: Record<PartKey, string> = { queue: "작업 큐(GitHub Issue)", evidence: "GitHub 증거(PR·리뷰)", runtime: "내부 실행 기록" };
export type SourceKind = "live" | "partial" | "unconnected" | "loading";
export type AgentKey = "gpt" | "codex" | "sonnet" | "opus";
export const AGENT_ORDER: AgentKey[] = ["gpt", "codex", "sonnet", "opus"];

export interface ModelInput { queue: Live<WorkQueueTask[]>; evidence: Live<EvidenceReport>; runtime: Live<Runtime> }
export interface HistoryEvent { id: string; at: string; taskId: string; actor: string; change: string; source: string; url?: string }
export interface ModelTask { id: string; title: string; url: string; agent: AgentKey | "unknown"; agentName: string; phase: string; phaseLabel: string; completion: string; completionLabel: string; complete: boolean; selfReportedOnly: boolean; next: string; waiting: string; prNumber?: number; missing: string[] }
export interface ModelProject { id: string; name: string; goal?: string; stage: string; counts: { total: number; completed: number; remaining: number; active: number; reported: number; unknown: number; completedWithoutOfficialReview: number }; tasks: ModelTask[]; completed: ModelTask[]; remaining: ModelTask[]; history: HistoryEvent[] }
export interface ModelAgent {
  key: AgentKey; name: string; role: string;
  /** GPT is always on (structural). Others: value read from the runtime snapshot, else "unknown". Controls are never editable in live mode. */
  control: { alwaysOn: boolean; enabled: boolean | "unknown"; effective: boolean | "unknown"; editable: false; note: string };
  /** Never fabricated: always unknown until a measured source exists. */
  usage: { state: "unknown" };
  /** "unverified": ACK/commits/runtime records are not proof of a currently running process. */
  execution: "unverified";
  recordedRuns: number | "unknown";
  assignments: { taskId: string; title: string; projectId: string; phaseLabel: string; complete: boolean; evidenceAt?: string }[];
  lastEvidenceAt?: string;
}
export interface BriefingItem { id: string; kind: "decision" | "approval" | "incident" | "next"; title: string; detail: string; taskId?: string; url?: string; at?: string; evidence: string }
export interface WorkspaceModelV1 {
  version: 1; source: SourceKind; sourceLabel: string;
  parts: Record<PartKey, PartState>; missingParts: PartKey[]; notes: string[];
  generatedAt?: string;
  projects: ModelProject[]; agents: ModelAgent[];
  briefing: { decisions: BriefingItem[]; approvals: BriefingItem[]; incidents: BriefingItem[]; next: BriefingItem[] };
  unclassifiedTasks: number;
}

const stateOf = (l: Live<unknown>): PartState => l.kind === "ok" ? "ok" : l.kind === "loading" ? "loading" : l.kind === "unconfigured" ? "unconfigured" : l.kind === "notoken" || l.kind === "unauth" ? "unauthenticated" : "error";
export const normalizeAgent = (a: string): AgentKey | "unknown" => a === "claude" || a === "claude-sonnet" || a === "sonnet" ? "sonnet" : a === "opus" || a === "claude-opus" ? "opus" : a === "codex" ? "codex" : a === "gpt" ? "gpt" : "unknown";
const ROLE: Record<AgentKey, string> = { gpt: "PM · 작업 분배와 최종 판단", codex: "코드 개발", sonnet: "개발 · 검수", opus: "설계 · 독립 검수" };
const NAME: Record<AgentKey, string> = { gpt: "GPT", codex: "Codex", sonnet: "Claude Sonnet", opus: "Claude Opus" };
const SOURCE_LABEL: Record<SourceKind, string> = { live: "실데이터 · 읽기 전용", partial: "일부만 연결됨 · 읽기 전용", unconnected: "연결되지 않음", loading: "불러오는 중" };

function toTask(w: Work): ModelTask {
  const lc = w.lifecycle;
  const complete = lc.completion === "complete";
  return { id: w.id, title: w.title, url: w.url, agent: normalizeAgent(w.agent), agentName: AI_NAMES[w.agent] ?? "담당 미정", phase: lc.phase, phaseLabel: phaseLabel(lc), completion: lc.completion, completionLabel: COMPLETION_LABEL[lc.completion],
    complete, selfReportedOnly: complete && lc.review !== "verified", next: w.next, waiting: w.waiting, prNumber: lc.pr?.number, missing: lc.missingEvidence };
}

export function buildWorkspaceModel(input: ModelInput): WorkspaceModelV1 {
  const parts: Record<PartKey, PartState> = { queue: stateOf(input.queue), evidence: stateOf(input.evidence), runtime: stateOf(input.runtime) };
  const missingParts = (Object.keys(parts) as PartKey[]).filter(k => parts[k] !== "ok");
  const notes: string[] = [];
  const empty = { decisions: [], approvals: [], incidents: [], next: [] };
  const agentsBase = (runtime?: Runtime): ModelAgent[] => AGENT_ORDER.map(key => {
    const r = runtime?.agents.find(a => normalizeAgent(a.key) === key);
    const alwaysOn = key === "gpt";
    return { key, name: NAME[key], role: ROLE[key], usage: { state: "unknown" as const }, execution: "unverified" as const,
      control: { alwaysOn, editable: false as const, enabled: alwaysOn ? true : r ? r.enabled : "unknown", effective: alwaysOn ? true : r ? r.effective : "unknown",
        note: alwaysOn ? "GPT는 항상 켜져 있습니다" : "조작은 개발계 전용입니다 · 실데이터 화면에서는 읽기만 가능" },
      recordedRuns: runtime ? runtime.runs.filter(x => normalizeAgent(x.agent) === key).length : "unknown", assignments: [] };
  });

  const q = input.queue;
  if (q.kind !== "ok") {
    const source: SourceKind = parts.queue === "loading" ? "loading" : "unconnected";
    if (source === "unconnected") notes.push("작업 큐를 읽지 못해 프로젝트와 업무를 만들지 않습니다. 추정값을 표시하지 않습니다.");
    return { version: 1, source, sourceLabel: SOURCE_LABEL[source], parts, missingParts, notes, projects: [], agents: agentsBase(input.runtime.kind === "ok" ? input.runtime.data : undefined), briefing: empty, unclassifiedTasks: 0 };
  }

  const report = input.evidence.kind === "ok" ? input.evidence.data : undefined;
  const runtime = input.runtime.kind === "ok" ? input.runtime.data : undefined;
  const model = workspace(q.data, report);
  const tasks = model.tasks.map(toTask);
  const byId = new Map(tasks.map(t => [t.id, t]));
  const projectOf = new Map(model.tasks.map(t => [t.id, t.project?.id ?? "unclassified"]));

  if (!report) notes.push("GitHub 증거(PR·리뷰)를 읽지 못해 업무 완료는 확인되지 않음으로 둡니다.");
  if (!runtime) notes.push("내부 실행 기록을 읽지 못해 AI별 ON/OFF·실행 기록은 확인 불가입니다.");
  if (report?.limits.issuesTruncated) notes.push("이슈 수집이 잘려 오래된 업무가 누락될 수 있습니다.");
  if (report?.limits.pullsTruncated) notes.push("PR 수집이 잘려 일부 업무의 PR 연결이 누락될 수 있습니다.");
  if (report?.limits.commentsTruncated) notes.push("코멘트 수집이 잘려 일부 업무는 확인되지 않음으로 표시됩니다.");
  const partial = missingParts.length > 0 || !!report && (report.limits.issuesTruncated || report.limits.pullsTruncated || report.limits.commentsTruncated);
  const source: SourceKind = partial ? "partial" : "live";

  const history: HistoryEvent[] = [];
  for (const e of report ? githubActivity(report, 200) : []) history.push({ id: `gh:${e.url ?? `${e.issue}:${e.at}:${e.kind}`}`, at: e.at, taskId: String(e.issue), actor: e.login, change: e.kind === "ack" ? "접수 보고(실행 미확인)" : e.kind === "completion" ? "개발 완료 보고 · 검수·배포와 별개" : e.kind === "approve" ? "검수 통과 보고" : e.kind === "revise" ? "수정 요청" : "GitHub 기록", source: "GitHub 자기보고", url: e.url });
  for (const r of runtime?.runs ?? []) for (const [k, change] of [["requestedAt", "작업 배정 기록"], ["ackAt", "수신 확인 기록"], ["startedAt", "시작 기록"], ["finishedAt", "종료 기록"]] as const) { const at = r[k]; if (at) history.push({ id: `rt:${r.dispatchId}:${k}`, at, taskId: String(r.issueNumber), actor: AI_NAMES[r.agent] ?? r.agent, change, source: "내부 실행 기록" }); }
  const hist = [...new Map(history.map(h => [h.id, h])).values()].sort((a, b) => b.at.localeCompare(a.at));

  const projects: ModelProject[] = model.projects.map((p: Project) => {
    const pt = p.tasks.map(w => byId.get(w.id)!);
    return { id: p.id, name: p.name, goal: p.goal, stage: p.stage,
      counts: { total: pt.length, completed: p.done, remaining: p.remaining, active: p.active, reported: p.reported, unknown: pt.filter(t => t.phase === "unknown").length, completedWithoutOfficialReview: p.doneWithoutOfficialReview },
      tasks: pt, completed: pt.filter(t => t.complete), remaining: pt.filter(t => !t.complete), history: hist.filter(h => projectOf.get(h.taskId) === p.id && byId.has(h.taskId)) };
  });

  const agents = agentsBase(runtime);
  for (const a of agents) {
    const mine = model.tasks.filter(w => normalizeAgent(w.agent) === a.key);
    a.assignments = mine.map(w => { const t = byId.get(w.id)!; return { taskId: t.id, title: t.title, projectId: projectOf.get(t.id)!, phaseLabel: t.phaseLabel, complete: t.complete, evidenceAt: hist.find(h => h.taskId === t.id)?.at }; });
    a.lastEvidenceAt = a.assignments.map(x => x.evidenceAt).filter((x): x is string => !!x).sort().at(-1);
  }

  const open = tasks.filter(t => !t.complete);
  const decisions: BriefingItem[] = open.filter(t => t.phase === "review").map(t => ({ id: `d:${t.id}`, kind: "decision", title: t.title, detail: t.next, taskId: t.id, url: t.url, evidence: `${t.phaseLabel} · ${t.completionLabel}` }));
  const approvals: BriefingItem[] = model.tasks.filter(w => ["verified", "pm-accepted"].includes(w.lifecycle.review)).map(w => ({ id: `a:${w.id}`, kind: "approval", title: w.title, taskId: w.id, url: w.url,
    detail: w.lifecycle.review === "verified" ? "공식 GitHub 승인(작성자 외)" : "PM 자기보고 수락 · 공식 승인 아님", evidence: `${COMPLETION_LABEL[w.lifecycle.completion]}` }));
  const incidents: BriefingItem[] = [
    ...open.filter(t => t.phase === "blocked").map(t => ({ id: `i:${t.id}`, kind: "incident" as const, title: t.title, detail: t.waiting, taskId: t.id, url: t.url, evidence: "상태 라벨 · 도움 필요" })),
    ...(runtime?.runs ?? []).filter(r => r.lastError).map(r => ({ id: `ir:${r.dispatchId}`, kind: "incident" as const, title: byId.get(String(r.issueNumber))?.title ?? `작업 #${r.issueNumber}`, detail: "실행 오류 기록 확인 필요", taskId: String(r.issueNumber), at: r.lastActivityAt, evidence: "내부 실행 기록" })),
    ...notes.map((n, i) => ({ id: `in:${i}`, kind: "incident" as const, title: "수집 한계", detail: n, evidence: "수집 상태" })),
  ];
  const next: BriefingItem[] = open.filter(t => t.phase !== "review" && t.phase !== "blocked").map(t => ({ id: `n:${t.id}`, kind: "next", title: t.title, detail: t.next, taskId: t.id, url: t.url, evidence: `${t.phaseLabel} · ${t.completionLabel}` }));

  return { version: 1, source, sourceLabel: SOURCE_LABEL[source], parts, missingParts, notes, generatedAt: report?.generatedAt ?? runtime?.generatedAt, projects, agents,
    briefing: { decisions, approvals, incidents, next }, unclassifiedTasks: model.tasks.filter(w => !w.project).length };
}
