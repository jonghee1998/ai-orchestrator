// 도메인 타입 정의 — 대시보드 전역에서 공유한다.
//
// 설계 원칙:
// - 확인할 수 없는 값은 임의로 만들지 않는다. 사용량/진행률은 "unknown"을 명시적으로 표현한다.
// - 실제 연결되지 않은 에이전트는 connected 로 표시하지 않는다.

/** 오케스트레이션 대상 에이전트 식별자 */
export type AgentId = "chatgpt" | "codex" | "claude-code" | "pickle";

/** 에이전트 역할 */
export type AgentRole =
  | "pm" //  작업 분배, 진행 관리, 최종 검수
  | "developer" // 코드 개발 및 수정
  | "reviewer" // 코드 리뷰, 독립 검수
  | "collector"; // 개인 데이터 수집 및 외부 서비스 작업

/** 에이전트 연결 상태 — 실제로 검증된 상태만 connected 로 둔다. */
export type ConnectionStatus =
  | "connected" //  실제 연결 확인됨
  | "disconnected" //  연결 안 됨 (기본값)
  | "connecting" //  연결 시도 중
  | "error"; //      연결 오류

/**
 * 값을 확인할 수 없는 경우를 1급으로 표현하는 래퍼.
 * 사용량/진행률 등 "모르면 unknown"이어야 하는 필드에 사용한다.
 */
export type Measured<T> =
  | { state: "known"; value: T }
  | { state: "unknown"; reason?: string };

export const unknown = <T>(reason?: string): Measured<T> => ({
  state: "unknown",
  reason,
});

export const known = <T>(value: T): Measured<T> => ({ state: "known", value });

/** 사용 한도 정보. 확인 불가한 필드는 Measured 로 감싼다. */
export interface UsageQuota {
  /** 한도 라벨 (예: "메시지", "요청") */
  label: string;
  /** 사용량 — 확인 불가 시 unknown */
  used: Measured<number>;
  /** 한도 상한 — 확인 불가 시 unknown */
  limit: Measured<number>;
  /** 한도 초기화 시각(ISO) — 확인 불가 시 unknown */
  resetsAt: Measured<string>;
}

/** 에이전트의 현재 상태 스냅샷 */
export interface AgentStatus {
  id: AgentId;
  name: string;
  role: AgentRole;
  /** 연결 방식 설명 (예: "구독 기반 CLI 인증") */
  connection: string;
  connectionStatus: ConnectionStatus;
  /** 클라우드에서 자동 실행 가능한지 여부 (구독 CLI 인증과 구분) */
  cloudCapable: Measured<boolean>;
  /** 마지막 상태 확인 시각(ISO) — 아직 확인 안 됐으면 unknown */
  lastCheckedAt: Measured<string>;
  usage: UsageQuota[];
}

export type TaskStatus =
  | "backlog"
  | "queued"
  | "in_progress"
  | "in_review"
  | "done"
  | "blocked";

/** 작업 — GitHub Issue 하나에 대응하도록 설계 */
export interface Task {
  id: string;
  title: string;
  projectId: string;
  /** 담당 에이전트 (미배정이면 null) */
  assignee: AgentId | null;
  status: TaskStatus;
  /** 연동된 GitHub Issue 번호 (아직 없으면 null) */
  issueNumber: number | null;
  /** 연동된 PR 번호 (아직 없으면 null) */
  prNumber: number | null;
  updatedAt: string;
}

export type ProjectStatus = "active" | "paused" | "done";

export interface Project {
  id: string;
  name: string;
  description: string;
  status: ProjectStatus;
  /** 진행률(%) — 자동 집계 전에는 unknown */
  progress: Measured<number>;
  taskCount: number;
}

export type ActivityKind =
  | "task_created"
  | "task_assigned"
  | "status_changed"
  | "agent_connected"
  | "handoff" // 에이전트 간 협업/인계 기록
  | "note";

/** 실행 로그 / 협업 기록 항목 */
export interface ActivityEvent {
  id: string;
  kind: ActivityKind;
  /** 이벤트를 발생시킨 주체 (에이전트 또는 "system") */
  actor: AgentId | "system";
  message: string;
  at: string; // ISO timestamp
  taskId?: string;
  projectId?: string;
}
