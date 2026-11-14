// 에이전트 어댑터 인터페이스
//
// 모든 에이전트(ChatGPT, Codex, Claude Code, Pickle)는 이 인터페이스를 구현한다.
// 대시보드와 작업 큐는 구체 어댑터가 아니라 이 인터페이스에만 의존한다.
//
// 중요:
// - checkConnection() 이 실제로 성공하기 전에는 어떤 어댑터도 connected 를 반환하지 않는다.
// - 사용량을 실제로 조회할 수 없으면 Measured 의 unknown 을 반환한다 (임의 생성 금지).
// - dispatch() 의 실제 실행 로직은 각 어댑터의 후속 단계에서 구현한다. Phase 1 에서는
//   인터페이스와 "미구현" 스텁만 제공한다.

import type {
  AgentId,
  AgentRole,
  ConnectionStatus,
  Measured,
  Task,
  UsageQuota,
} from "@/lib/types";

/** 작업을 어댑터에 전달한 결과 */
export interface DispatchResult {
  accepted: boolean;
  /** 생성/연동된 GitHub Issue 번호 */
  issueNumber: number | null;
  /** 사람이 읽을 수 있는 설명 */
  detail: string;
}

/** 어댑터가 자신을 설명하는 정적 메타데이터 */
export interface AgentDescriptor {
  id: AgentId;
  name: string;
  role: AgentRole;
  /** 연결 방식 설명 (예: "구독 기반 CLI 인증 (로컬)") */
  connection: string;
  /**
   * 클라우드에서 PC 없이 자동 실행 가능한지 여부.
   * 구독 기반 CLI 인증은 로컬 세션에 묶이는 경우가 많으므로 반드시 구분한다.
   */
  cloudCapable: Measured<boolean>;
}

/**
 * 에이전트 어댑터 공통 계약.
 * Phase 1 에서는 checkConnection / getUsage 는 보수적으로(unknown / disconnected)
 * 동작하고, dispatch 는 미구현 상태를 명시적으로 반환한다.
 */
export interface AgentAdapter {
  readonly descriptor: AgentDescriptor;

  /**
   * 실제 연결 상태를 확인한다.
   * 실제 검증에 성공한 경우에만 "connected" 를 반환해야 한다.
   */
  checkConnection(): Promise<ConnectionStatus>;

  /**
   * 사용 한도/사용량을 조회한다.
   * 조회할 수 없으면 각 필드를 unknown 으로 채운 UsageQuota 배열을 반환한다.
   */
  getUsage(): Promise<UsageQuota[]>;

  /**
   * 작업을 에이전트에 전달한다 (GitHub Issue 기반 핸드오프).
   * Phase 1 에서는 미구현. 실제 실행은 후속 단계에서 구현한다.
   */
  dispatch(task: Task): Promise<DispatchResult>;
}

/** 아직 실행이 구현되지 않은 어댑터를 위한 표준 dispatch 결과 */
export function notImplementedDispatch(agentName: string): DispatchResult {
  return {
    accepted: false,
    issueNumber: null,
    detail: `${agentName} 어댑터의 작업 실행은 아직 구현되지 않았습니다 (Phase 1 범위 외).`,
  };
}
