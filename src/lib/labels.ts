// 역할/식별자 한국어 라벨

import type { AgentId, AgentRole } from "./types";

export const roleLabel: Record<AgentRole, string> = {
  pm: "PM · 작업 분배/검수",
  developer: "개발 · 코드 작성/수정",
  reviewer: "리뷰 · 코드 리뷰/검수",
  collector: "수집 · 데이터/외부 작업",
};

export const agentLabel: Record<AgentId, string> = {
  chatgpt: "ChatGPT",
  codex: "Codex",
  "claude-code": "Claude Code",
  pickle: "Pickle",
};
