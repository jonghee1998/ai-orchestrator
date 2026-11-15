// GitHub Issue 기반 작업 큐 설계
//
// 작업 전달/회신의 단일 출처(source of truth)는 GitHub Issues/PR 로 둔다.
// 대시보드는 이 큐를 읽어 상태를 표시하고, 에이전트는 Issue 코멘트/라벨/PR 로 회신한다.
//
// 매핑 규약 (Phase 1 설계):
// - 작업 1개          ↔ Issue 1개
// - 담당 에이전트       ↔ 라벨 `agent:<id>` (예: agent:claude-code)
// - 작업 상태          ↔ 라벨 `status:<state>` (예: status:in_progress)
// - 프로젝트          ↔ 라벨 `project:<id>` 또는 마일스톤
// - 에이전트 간 협업/인계 ↔ Issue 코멘트 (actor 표기)
// - 작업 결과          ↔ 연결된 PR (Closes #<issue>)
//
// Phase 1 에서는 인터페이스와 라벨 규약만 정의한다. 실제 GitHub API 호출(Octokit 등)은
// 토큰 설정과 사용자 승인 후 Phase 2 에서 구현한다.

import type { AgentId, Task, TaskStatus } from "@/lib/types";

/** 라벨 네임스페이스 접두사 */
export const LABEL = {
  agent: (id: AgentId) => `agent:${id}`,
  status: (s: TaskStatus) => `status:${s}`,
  project: (projectId: string) => `project:${projectId}`,
} as const;

/** 작업 상태 ↔ GitHub 상태 라벨 매핑 (역방향 파싱용) */
export const STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: "status:backlog",
  queued: "status:queued",
  in_progress: "status:in_progress",
  in_review: "status:in_review",
  done: "status:done",
  blocked: "status:blocked",
};

export interface CreateTaskInput {
  title: string;
  body: string;
  projectId: string;
  assignee: AgentId | null;
}

/**
 * 작업 큐 인터페이스. 구현체는 GitHub Issues API 를 사용한다.
 * Phase 1 에서는 설계(계약)만 제공하며, 구현체는 Phase 2.
 */
export interface TaskQueue {
  /** 큐의 모든 작업(열린 Issue)을 조회 */
  list(): Promise<Task[]>;
  /** 새 작업을 생성 (Issue 생성 + 라벨 부여) */
  create(input: CreateTaskInput): Promise<Task>;
  /** 작업 상태 변경 (status 라벨 교체) */
  setStatus(taskId: string, status: TaskStatus): Promise<void>;
  /** 작업 담당자 변경 (agent 라벨 교체) */
  assign(taskId: string, agent: AgentId | null): Promise<void>;
  /** 협업/인계 기록 추가 (Issue 코멘트) */
  comment(taskId: string, actor: AgentId | "system", message: string): Promise<void>;
}

/** 아직 큐 구현이 연결되지 않았음을 나타내는 표준 에러 */
export class TaskQueueNotConfiguredError extends Error {
  constructor() {
    super(
      "GitHub 작업 큐가 아직 구성되지 않았습니다. GITHUB_TOKEN 설정과 사용자 승인 후 Phase 2 에서 활성화됩니다.",
    );
    this.name = "TaskQueueNotConfiguredError";
  }
}
