// UI 로컬 뷰 모델 — GET /api/work-queue 계약을 화면용 구조로 변환한다.
// 공용 도메인 타입은 변경하지 않는다. 없는 값은 만들지 않고 unknown 으로 둔다.

export type QueueAgent = "claude" | "opus" | "codex" | "unknown";

export interface QueueTask {
  id: string;
  title: string;
  agent: QueueAgent;
  status: string;
  dependsOn: string[];
  url: string;
}

export interface WorkQueueResponse {
  mode: "live" | "unconfigured" | "error";
  tasks: QueueTask[];
  error?: string;
}

export type Phase = "active" | "ready" | "review" | "done" | "blocked" | "unknown";

export interface TaskView extends QueueTask {
  phase: Phase;
  /** 아직 완료되지 않은 선행 작업 id */
  waitingOn: string[];
  /** 목록에 없는 선행 작업 id (상태 확인 불가) */
  missingDeps: string[];
}

export interface Handoff {
  from: TaskView;
  to: TaskView;
}

export interface DashboardModel {
  tasks: TaskView[];
  byAgent: Record<QueueAgent, TaskView[]>;
  concurrent: TaskView[];
  handoffs: Handoff[];
  blocked: TaskView[];
  unknownState: TaskView[];
}

export const AGENTS: QueueAgent[] = ["claude", "opus", "codex", "unknown"];

export function classify(status: string): Phase {
  const s = status.toLowerCase();
  if (!s.trim()) return "unknown";
  if (s.includes("blocked")) return "blocked";
  if (s.includes("in-progress") || s.includes("in_progress")) return "active";
  if (s.includes("review")) return "review";
  if (s.includes("done") || s.includes("closed") || s.includes("complete"))
    return "done";
  if (s.includes("ready") || s.includes("queued") || s.includes("open"))
    return "ready";
  return "unknown";
}

export function buildModel(input: QueueTask[]): DashboardModel {
  const raw = new Map(input.map((t) => [t.id, classify(t.status)]));
  const tasks: TaskView[] = input.map((t) => {
    const missingDeps = t.dependsOn.filter((d) => !raw.has(d));
    const waitingOn = t.dependsOn.filter(
      (d) => raw.has(d) && raw.get(d) !== "done",
    );
    let phase = raw.get(t.id)!;
    if (phase !== "done" && (waitingOn.length || missingDeps.length)) {
      if (phase === "ready" || phase === "active") phase = "blocked";
    }
    return { ...t, phase, waitingOn, missingDeps };
  });
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const byAgent: Record<QueueAgent, TaskView[]> = {
    claude: [],
    opus: [],
    codex: [],
    unknown: [],
  };
  for (const t of tasks) byAgent[t.agent].push(t);
  const handoffs: Handoff[] = [];
  for (const t of tasks)
    for (const d of t.dependsOn) {
      const from = byId.get(d);
      if (from) handoffs.push({ from, to: t });
    }
  return {
    tasks,
    byAgent,
    concurrent: tasks.filter((t) => t.phase === "active"),
    handoffs,
    blocked: tasks.filter((t) => t.phase === "blocked"),
    unknownState: tasks.filter(
      (t) => t.phase === "unknown" || t.agent === "unknown" || t.missingDeps.length > 0,
    ),
  };
}

export function parseResponse(v: unknown): WorkQueueResponse | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o.mode !== "live" && o.mode !== "unconfigured" && o.mode !== "error")
    return null;
  if (!Array.isArray(o.tasks)) return null;
  const tasks: QueueTask[] = [];
  for (const t of o.tasks) {
    if (!t || typeof t !== "object") continue;
    const r = t as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.title !== "string") continue;
    const agent: QueueAgent =
      r.agent === "claude" || r.agent === "opus" || r.agent === "codex"
        ? r.agent
        : "unknown";
    tasks.push({
      id: r.id,
      title: r.title,
      agent,
      status: typeof r.status === "string" ? r.status : "",
      dependsOn: Array.isArray(r.dependsOn)
        ? r.dependsOn.filter((x): x is string => typeof x === "string")
        : [],
      url: typeof r.url === "string" ? r.url : "",
    });
  }
  return {
    mode: o.mode,
    tasks,
    error: typeof o.error === "string" ? o.error : undefined,
  };
}
