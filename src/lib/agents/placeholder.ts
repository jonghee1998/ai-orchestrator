// Codex / ChatGPT / Pickle 어댑터 — 후속 단계 placeholder.
//
// 세 에이전트는 Phase 1 에서 연결 대상이 아니다. 인터페이스만 구현하며,
// 연결 상태는 disconnected, 사용량은 unknown, 실행은 미구현으로 보고한다.

import type { ConnectionStatus, Task, UsageQuota } from "@/lib/types";
import { unknown } from "@/lib/types";
import {
  type AgentAdapter,
  type AgentDescriptor,
  type DispatchResult,
  notImplementedDispatch,
} from "./adapter";

/** 아직 연결 작업을 시작하지 않은 에이전트를 위한 공통 placeholder 어댑터 */
export class PlaceholderAdapter implements AgentAdapter {
  constructor(readonly descriptor: AgentDescriptor) {}

  async checkConnection(): Promise<ConnectionStatus> {
    return "disconnected";
  }

  async getUsage(): Promise<UsageQuota[]> {
    return [
      {
        label: "사용량",
        used: unknown("연결 전"),
        limit: unknown("연결 전"),
        resetsAt: unknown("연결 전"),
      },
    ];
  }

  async dispatch(_task: Task): Promise<DispatchResult> {
    return notImplementedDispatch(this.descriptor.name);
  }
}

export const chatgptAdapter = new PlaceholderAdapter({
  id: "chatgpt",
  name: "ChatGPT",
  role: "pm",
  connection: "미정 (후속 단계)",
  cloudCapable: unknown("연결 전"),
});

export const codexAdapter = new PlaceholderAdapter({
  id: "codex",
  name: "Codex",
  role: "developer",
  connection: "CLI (후속 단계)",
  cloudCapable: unknown("연결 전"),
});

export const pickleAdapter = new PlaceholderAdapter({
  id: "pickle",
  name: "Pickle",
  role: "collector",
  connection: "미정 (후속 단계)",
  cloudCapable: unknown("연결 전"),
});
