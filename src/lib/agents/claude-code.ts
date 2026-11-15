// Claude Code 어댑터 — 1차 실제 연결 대상.
//
// Claude Code 는 구독 기반 CLI 인증을 사용하므로, 연결 확인은 로컬 머신에서
// CLI 인증 상태를 검증하는 방식으로 후속 단계에 구현한다.
// Phase 1 에서는 인터페이스를 구현하되, 실제 검증 전에는 connected 로 보고하지 않는다.

import type { ConnectionStatus, Task, UsageQuota } from "@/lib/types";
import { unknown } from "@/lib/types";
import {
  type AgentAdapter,
  type AgentDescriptor,
  type DispatchResult,
  notImplementedDispatch,
} from "./adapter";

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly descriptor: AgentDescriptor = {
    id: "claude-code",
    name: "Claude Code",
    role: "reviewer",
    connection: "구독 기반 CLI 인증 (로컬 머신)",
    // 구독 CLI 인증은 로컬 세션에 묶이므로, 클라우드 자동 실행 가능 여부는 아직 확인되지 않음.
    cloudCapable: unknown("구독 CLI 인증의 클라우드 자동 실행 가능 여부 미확인"),
  };

  async checkConnection(): Promise<ConnectionStatus> {
    // TODO(phase-2): 로컬에서 `claude` CLI 인증 상태를 실제로 확인한다.
    // 실제 검증이 구현되기 전까지는 연결 안 됨으로 보고한다 (허위 연결 표시 금지).
    return "disconnected";
  }

  async getUsage(): Promise<UsageQuota[]> {
    // 실제 사용량 조회 API 가 연결되기 전에는 모두 unknown.
    return [
      {
        label: "요청",
        used: unknown("사용량 조회 미연결"),
        limit: unknown("한도 조회 미연결"),
        resetsAt: unknown("초기화 시각 조회 미연결"),
      },
    ];
  }

  async dispatch(_task: Task): Promise<DispatchResult> {
    return notImplementedDispatch(this.descriptor.name);
  }
}
