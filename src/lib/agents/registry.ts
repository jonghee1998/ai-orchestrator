// 어댑터 레지스트리 — 모든 에이전트 어댑터를 한 곳에서 등록/조회한다.

import type { AgentAdapter } from "./adapter";
import { ClaudeCodeAdapter } from "./claude-code";
import { chatgptAdapter, codexAdapter, pickleAdapter } from "./placeholder";
import type { AgentId } from "@/lib/types";

export const adapters: Record<AgentId, AgentAdapter> = {
  chatgpt: chatgptAdapter,
  codex: codexAdapter,
  "claude-code": new ClaudeCodeAdapter(),
  pickle: pickleAdapter,
};

export function getAdapter(id: AgentId): AgentAdapter {
  return adapters[id];
}

export function allAdapters(): AgentAdapter[] {
  return Object.values(adapters);
}
