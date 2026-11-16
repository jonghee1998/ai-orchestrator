export type AgentId = "gpt" | "codex" | "sonnet" | "opus";
export type TaskState = "planned" | "assigned" | "running" | "review" | "revision" | "decision" | "paused" | "done" | "failed";
export type ProjectState = "active" | "done";

export interface SimTask {
  id: string; title: string; stageId: string; agent: AgentId; state: TaskState;
  criterion: string; result?: string; failure?: string; runStartedAt?: string;
}
export interface SimStage {
  id: string; title: string; goal: string; criterion: string; status: "planned" | "active" | "done"; agent?: AgentId;
}
export interface SimProject {
  id: string; name: string; goal: string; description: string; repository?: string;
  state: ProjectState; stages: SimStage[]; tasks: SimTask[];
}
export interface SimAgent {
  id: AgentId; name: string; role: string; manualEnabled: boolean; usageRestricted: boolean;
}
export interface UsagePeriod {
  id: "daily" | "weekly"; label: string; used: number | null; resetsAt: string | null;
  checkedAt: string; source: string; stale?: boolean;
}
export interface UsageService { id: "codex" | "claude"; name: string; periods: UsagePeriod[] }
export interface Briefing {
  id: string; type: "decision" | "change" | "complete" | "usage"; projectId?: string;
  title: string; summary: string; at: string; next: string; owner: string; userAction?: string;
  decision?: "pending" | "approved" | "held"; evidence?: string;
}
export interface SimulationState {
  version: 1; projects: SimProject[]; agents: SimAgent[]; usage: UsageService[]; briefings: Briefing[];
  scenario: "normal" | "empty" | "partial-failure" | "error"; updatedAt: string;
  policy: { enabled: boolean; threshold: number };
}

const isoAfter = (now: number, hours: number) => new Date(now + hours * 3_600_000).toISOString();
const stage = (id: string, title: string, status: SimStage["status"], goal: string): SimStage => ({ id, title, status, goal, criterion: `${title} 결과와 검수 근거가 등록됨`, agent: title.includes("기획") || title.includes("검수") ? "gpt" : "codex" });

export function initialSimulation(now = Date.now()): SimulationState {
  const checkedAt = new Date(now).toISOString();
  return {
    version: 1,
    scenario: "normal",
    updatedAt: checkedAt,
    policy: { enabled: true, threshold: 90 },
    agents: [
      { id: "gpt", name: "GPT", role: "PM, 기획, 업무 배분, 독립 검수", manualEnabled: true, usageRestricted: false },
      { id: "codex", name: "Codex", role: "코드 개발, 구현, 테스트", manualEnabled: true, usageRestricted: false },
      { id: "sonnet", name: "Claude Sonnet", role: "일반 개발, 코드 수정", manualEnabled: false, usageRestricted: false },
      { id: "opus", name: "Claude Opus", role: "고난도 설계 및 복잡한 개발", manualEnabled: false, usageRestricted: false },
    ],
    usage: ["codex", "claude"].map((id) => ({
      id: id as "codex" | "claude", name: id === "codex" ? "GPT (Codex)" : "Claude",
      periods: [
        { id: "daily", label: "일별", used: 40, resetsAt: isoAfter(now, 3), checkedAt, source: "개발계 가상 사용량" },
        { id: "weekly", label: "주별", used: 15, resetsAt: isoAfter(now, 73), checkedAt, source: "개발계 가상 사용량" },
      ],
    })),
    projects: [
      {
        id: "orchestrator", name: "AI Orchestrator", goal: "AI 협업 운영 플랫폼 구축", description: "여러 AI의 계획, 실행, 검수 상황을 모바일에서 관리합니다.", repository: "jonghee1998/ai-orchestrator", state: "active",
        stages: [stage("o1", "기획 및 구조 설계", "done", "업무 중심 정보 구조 확정"), stage("o2", "데이터 구조 및 설계", "done", "시뮬레이션 모델 확정"), stage("o3", "모바일 UI 개발", "active", "3탭 모바일 화면 구현"), stage("o4", "기능 연동 및 테스트", "planned", "상태 전이와 회귀 검증"), stage("o5", "검증 및 배포", "planned", "독립 검수 후 배포 판단")],
        tasks: [
          { id: "t1", title: "3탭 모바일 화면 구현", stageId: "o3", agent: "codex", state: "running", criterion: "360·390·430px에서 핵심 화면 확인" , runStartedAt: checkedAt },
          { id: "t2", title: "모바일 화면 구조 승인", stageId: "o3", agent: "gpt", state: "decision", criterion: "사용자 승인 또는 보류 기록" },
          { id: "t3", title: "로그인과 데모 격리 회귀 검증", stageId: "o4", agent: "codex", state: "assigned", criterion: "자동 테스트 통과" },
        ],
      },
      {
        id: "private-dashboard", name: "Private Dashboard", goal: "개인 금융 및 생활 대시보드", description: "일상 정보를 한곳에서 확인하는 가상 개발 프로젝트입니다.", state: "active",
        stages: [stage("p1", "요구사항 정리", "done", "표시 항목 확정"), stage("p2", "대시보드 개발", "active", "모바일 카드 구현"), stage("p3", "검수", "planned", "샘플 데이터 검수")],
        tasks: [{ id: "t4", title: "생활 지표 카드 개발", stageId: "p2", agent: "codex", state: "assigned", criterion: "샘플 카드 표시" }],
      },
      {
        id: "completed-sample", name: "가상 완료 프로젝트", goal: "완료 상태 화면 검증", description: "개발계 완료 필터를 검증하는 가상 프로젝트입니다.", state: "done",
        stages: [stage("c1", "개발계 검증", "done", "완료 화면 확인")],
        tasks: [{ id: "t5", title: "완료 상태 확인", stageId: "c1", agent: "gpt", state: "done", criterion: "완료 근거 등록", result: "개발계 가상 검증 통과" }],
      },
    ],
    briefings: [
      { id: "b1", type: "decision", projectId: "orchestrator", title: "모바일 화면 구조 승인 필요", summary: "3탭 화면의 정보 배치를 확인해 주세요.", at: checkedAt, next: "개발계 화면 확인", owner: "사용자", userAction: "승인 또는 보류", decision: "pending", evidence: "개발계 시뮬레이션" },
      { id: "b2", type: "change", projectId: "orchestrator", title: "모바일 UI 개발 진행 중", summary: "Codex가 3탭 화면을 구현하고 있습니다.", at: checkedAt, next: "구현과 자동 검증", owner: "Codex", evidence: "개발계 가상 실행" },
    ],
  };
}

export const agentAvailable = (state: SimulationState, id: AgentId) => {
  const a = state.agents.find((item) => item.id === id);
  return !!a?.manualEnabled && !a.usageRestricted;
};

export function remaining(reset: string | null, now = Date.now()): string {
  if (!reset) return "확인 불가";
  const ms = Date.parse(reset) - now;
  if (ms <= 0) return "초기화 예정";
  const minutes = Math.ceil(ms / 60_000); const days = Math.floor(minutes / 1440); const hours = Math.floor((minutes % 1440) / 60); const mins = minutes % 60;
  return [days ? `${days}일` : "", hours ? `${hours}시간` : "", !days && mins ? `${mins}분` : ""].filter(Boolean).join(" ") + " 뒤 초기화";
}

export function recalculateRestrictions(state: SimulationState): SimulationState {
  const limited = (service: "codex" | "claude") => state.policy.enabled && state.usage.find((u) => u.id === service)?.periods.some((p) => p.used !== null && p.used >= state.policy.threshold);
  return { ...state, agents: state.agents.map((a) => ({ ...a, usageRestricted: a.id === "codex" ? !!limited("codex") : a.id === "sonnet" || a.id === "opus" ? !!limited("claude") : false })) };
}
