// One presentation model for all four tabs. Missing project/goal/evidence stays unknown.
import type { WorkQueueTask } from "./work-queue";
import type { EvidenceReport, IssueEvidence } from "./evidence";
import { githubActivity } from "./evidence-views";
import { lifecycleOf, projectComplete, type Lifecycle } from "../workflow/lifecycle";
export const AI_NAMES: Record<string, string> = { claude: "Claude Sonnet", opus: "Claude Opus", codex: "Codex", gpt: "GPT", "claude-sonnet": "Claude Sonnet", "claude-opus": "Claude Opus", unknown: "담당 미정" };
export type WorkPhase = "remaining" | "active" | "review" | "blocked" | "done" | "unknown";
export const PHASE_LABEL: Record<WorkPhase, string> = { remaining: "시작 대기", active: "진행 중", review: "검수·결정 필요", blocked: "도움 필요", done: "업무 완료", unknown: "확인되지 않음" };
export type Work = WorkQueueTask & { phase: WorkPhase; next: string; waiting: string; proof?: IssueEvidence; lifecycle: Lifecycle };
export interface Project { id: string; name: string; goal?: string; tasks: Work[]; done: number; active: number; remaining: number; stage: string }
export interface Runtime { generatedAt: string; agents: { key: string; enabled: boolean; effective: boolean; running: number; queued: number; held: number; lastHeartbeat: string | null; lastAck: string | null }[]; runs: { dispatchId: string; issueNumber: number; agent: string; status: string; requestedAt?: string; ackAt?: string | null; startedAt?: string | null; finishedAt?: string | null; execution?: { tests: { command: string; exitCode: number }[] } | null; lastActivityAt?: string; lastError?: string | null; evidence?: { kind: string; url: string }[] }[]; audit: { at: string; actor: string; action: string; detail: string }[] }
export function workspace(tasks: WorkQueueTask[], evidence?: EvidenceReport): { projects: Project[]; tasks: Work[] } {
  // Closed issue / merged PR / status label alone never mean "done": completion needs evidence for the declared completion type.
  const life = (t: WorkQueueTask): Lifecycle => lifecycleOf({ description: t.description, status: t.status, issueState: t.issueState, evidence: evidence?.issues.find(i => String(i.number) === t.id) });
  const lifeById = new Map(tasks.map(t => [t.id, life(t)]));
  const done = (t: WorkQueueTask) => lifeById.get(t.id)!.complete;
  const rows: Work[] = tasks.map(t => {
    const status = t.status.replace(/^status:/, "");
    const lifecycle = lifeById.get(t.id)!;
    const lp = lifecycle.phase;
    let phase: WorkPhase = lifecycle.complete ? "done" : lp === "closed_unverified" || lp === "unverifiable" ? "unknown" : lp === "review" || lp === "stale_review" || lp === "deploy_pending" || lp === "integrated" ? "review" : lp === "received" ? "remaining" : status === "blocked" ? "blocked" : status === "review" || status === "done" ? "review" : status === "in-progress" ? "active" : ["ready", "queued", "backlog"].includes(status) ? "remaining" : "unknown";
    const unmet = t.dependsOn.filter(id => !tasks.some(x => x.id === id && done(x)));
    if (unmet.length && phase !== "done" && phase !== "review") phase = "blocked";
    return { ...t, phase, lifecycle, proof: evidence?.issues.find(i => String(i.number) === t.id),
      next: phase === "done" ? "종료된 업무와 결과를 확인하세요" : phase === "review" ? "결과를 읽고 검수·결정 내용을 확인하세요" : phase === "blocked" ? "대기 중인 내용이나 선행 작업을 확인하세요" : phase === "active" ? "다음 진행 소식을 기다려 주세요" : phase === "remaining" ? "담당과 선행 작업을 확인한 뒤 시작을 준비하세요" : "작업 상태를 먼저 확인하세요",
      waiting: !unmet.length && !lifecycle.complete && lifecycle.missingEvidence.length && lp !== "not_started" ? `${lifecycle.label} — 필요한 증거: ${lifecycle.missingEvidence.join(", ")}` : unmet.length ? `선행 작업 ${unmet.map(id => `#${id}`).join(", ")} 확인 대기` : phase === "blocked" ? "추가 정보 또는 결정 대기" : phase === "review" ? "검수·결정 대기" : phase === "remaining" ? "작업 시작 대기" : phase === "unknown" ? "진행 정보 확인 필요" : "대기 사항 없음",
    };
  });
  const grouped = new Map<string, Project>();
  for (const t of rows) {
    const id = t.project?.id ?? "unclassified";
    if (!grouped.has(id)) grouped.set(id, { id, name: t.project?.name ?? "미분류", goal: t.project?.goal, tasks: [], done: 0, active: 0, remaining: 0, stage: "시작 준비" });
    grouped.get(id)!.tasks.push(t);
  }
  for (const p of grouped.values()) {
    p.done = p.tasks.filter(t => t.lifecycle.complete).length;
    p.active = p.tasks.filter(t => t.phase === "active" || t.phase === "review").length;
    p.remaining = p.tasks.length - p.done;
    p.stage = projectComplete(p.tasks.map(t => t.lifecycle)) ? "업무 완료" : p.tasks.some(t => t.phase === "blocked") ? "확인·도움 필요" : p.tasks.some(t => t.phase === "review") ? "검수 중" : p.active ? "진행 중" : "시작 준비";
  }
  return { projects: [...grouped.values()], tasks: rows };
}
export const projectHref = (id: string) => `/projects/${encodeURIComponent(id)}`;
export const taskHref = (t: Work) => `${projectHref(t.project?.id ?? "unclassified")}/tasks/${encodeURIComponent(t.id)}`;
export interface WorkEvent { id: string; at: string; title: string; actor: string; change: string; source: string; url?: string; raw: string }
export function workActivity(tasks: Work[], evidence?: EvidenceReport, runtime?: Runtime): WorkEvent[] {
  const out: WorkEvent[] = [];
  const title = (id: string) => tasks.find(t => t.id === id)?.title ?? `작업 #${id}`;
  const labels = { ack: "작업 수신 확인", completion: "개발 완료 보고 · 검수·배포 완료와 별개", approve: "검수 통과 보고 · 배포 여부는 별도 확인", revise: "수정 요청", review: "검수 결과 등록", pr: "결과 자료 등록" };
  for (const e of evidence ? githubActivity(evidence, 100) : []) out.push({ id: `github:${e.url ?? `${e.issue}:${e.at}:${e.kind}`}`, at: e.at, title: title(String(e.issue)), actor: AI_NAMES[tasks.find(t => t.id === String(e.issue))?.agent ?? "unknown"], change: labels[e.kind], source: "GitHub 자기보고", url: e.url, raw: `${e.login} · ${e.text}` });
  for (const r of runtime?.runs ?? []) {
    for (const [key, change] of [["requestedAt", "작업 배정 기록"], ["ackAt", "작업 수신 확인"], ["startedAt", "작업 시작 기록"], ["finishedAt", "실행 종료 기록 · 검수·배포 완료와 별개"]] as const) {
      const at = r[key]; if (at) out.push({ id: `runtime:${r.dispatchId}:${key}`, at, title: title(String(r.issueNumber)), actor: AI_NAMES[r.agent] ?? r.agent, change, source: "내부 실행 기록", raw: `${r.dispatchId} · ${r.status}` });
    }
    if (r.lastError && r.lastActivityAt) out.push({ id: `runtime:${r.dispatchId}:error`, at: r.lastActivityAt, title: title(String(r.issueNumber)), actor: AI_NAMES[r.agent] ?? r.agent, change: "실패·지연 확인 필요", source: "내부 실행 기록", raw: r.lastError });
  }
  for (const a of runtime?.audit ?? []) out.push({ id: `setting:${a.at}:${a.actor}:${a.action}:${a.detail}`, at: a.at, title: "배정 설정", actor: AI_NAMES[a.actor] ?? a.actor, change: "설정 변경", source: "내부 설정 기록", raw: `${a.action} · ${a.detail}` });
  return [...new Map(out.map(e => [e.id, e])).values()].sort((a,b) => b.at.localeCompare(a.at));
}
