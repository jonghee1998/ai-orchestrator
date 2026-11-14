// 샘플(데모) 데이터 — UI 레이아웃 확인용이며 실제 실행 데이터가 아니다.
//
// ⚠️ 중요 (제약 준수):
// - 모든 에이전트 연결 상태는 "disconnected" 로 둔다. 실제 연결 전까지 connected 표시 금지.
// - 사용량/한도/진행률 등 확인할 수 없는 값은 unknown 으로 둔다. 임의 수치 생성 금지.
// - 아래 프로젝트/작업/활동은 화면 구성을 보여주기 위한 예시이며, SAMPLE_MODE 플래그로
//   UI 에서 "샘플 데이터" 임을 명확히 표기한다.
//
// 실제 데이터는 Phase 2 에서 GitHub 작업 큐 및 어댑터 연결을 통해 주입된다.

import {
  type ActivityEvent,
  type AgentStatus,
  type Project,
  type Task,
  unknown,
} from "./types";

/** 이 데이터가 실제 연동이 아닌 샘플임을 나타내는 전역 플래그 */
export const SAMPLE_MODE = true;

/** 에이전트 상태 — 전부 연결 안 됨 / 사용량 unknown (실제 검증 전) */
export const agents: AgentStatus[] = [
  {
    id: "chatgpt",
    name: "ChatGPT",
    role: "pm",
    connection: "미정 (후속 단계)",
    connectionStatus: "disconnected",
    cloudCapable: unknown("연결 전"),
    lastCheckedAt: unknown("아직 확인 안 됨"),
    usage: [
      { label: "메시지", used: unknown(), limit: unknown(), resetsAt: unknown() },
    ],
  },
  {
    id: "codex",
    name: "Codex",
    role: "developer",
    connection: "CLI (후속 단계)",
    connectionStatus: "disconnected",
    cloudCapable: unknown("연결 전"),
    lastCheckedAt: unknown("아직 확인 안 됨"),
    usage: [
      { label: "요청", used: unknown(), limit: unknown(), resetsAt: unknown() },
    ],
  },
  {
    id: "claude-code",
    name: "Claude Code",
    role: "reviewer",
    connection: "구독 기반 CLI 인증 (로컬 머신)",
    connectionStatus: "disconnected",
    cloudCapable: unknown("구독 CLI 인증의 클라우드 자동 실행 가능 여부 미확인"),
    lastCheckedAt: unknown("아직 확인 안 됨"),
    usage: [
      { label: "요청", used: unknown(), limit: unknown(), resetsAt: unknown() },
    ],
  },
  {
    id: "pickle",
    name: "Pickle",
    role: "collector",
    connection: "미정 (후속 단계)",
    connectionStatus: "disconnected",
    cloudCapable: unknown("연결 전"),
    lastCheckedAt: unknown("아직 확인 안 됨"),
    usage: [
      { label: "작업", used: unknown(), limit: unknown(), resetsAt: unknown() },
    ],
  },
];

/** 샘플 프로젝트 — 진행률은 unknown (자동 집계 전) */
export const projects: Project[] = [
  {
    id: "orchestrator",
    name: "AI Orchestrator",
    description: "다중 AI 에이전트 관리 대시보드 (본 저장소)",
    status: "active",
    progress: unknown("자동 집계 전"),
    taskCount: 3,
  },
  {
    id: "example",
    name: "(샘플) 예시 프로젝트",
    description: "화면 구성을 보여주기 위한 예시 프로젝트",
    status: "paused",
    progress: unknown("자동 집계 전"),
    taskCount: 1,
  },
];

/** 샘플 작업 — Issue/PR 연동 전이므로 번호는 대부분 null */
export const tasks: Task[] = [
  {
    id: "t-1",
    title: "Phase 1 기반 구조 구축",
    projectId: "orchestrator",
    assignee: "claude-code",
    status: "in_progress",
    issueNumber: 1,
    prNumber: null,
    updatedAt: "2026-11-14T00:00:00.000Z",
  },
  {
    id: "t-2",
    title: "GitHub 작업 큐 API 구현 (Phase 2)",
    projectId: "orchestrator",
    assignee: null,
    status: "backlog",
    issueNumber: null,
    prNumber: null,
    updatedAt: "2026-11-14T00:00:00.000Z",
  },
  {
    id: "t-3",
    title: "Claude Code CLI 실제 연결 검증",
    projectId: "orchestrator",
    assignee: "claude-code",
    status: "backlog",
    issueNumber: null,
    prNumber: null,
    updatedAt: "2026-11-14T00:00:00.000Z",
  },
  {
    id: "t-4",
    title: "(샘플) 예시 작업",
    projectId: "example",
    assignee: null,
    status: "backlog",
    issueNumber: null,
    prNumber: null,
    updatedAt: "2026-11-14T00:00:00.000Z",
  },
];

/** 샘플 활동 로그 */
export const activity: ActivityEvent[] = [
  {
    id: "a-1",
    kind: "task_created",
    actor: "system",
    message: "Phase 1 작업 계획이 GitHub Issue #1 로 생성되었습니다.",
    at: "2026-11-14T00:00:00.000Z",
    projectId: "orchestrator",
    taskId: "t-1",
  },
  {
    id: "a-2",
    kind: "note",
    actor: "system",
    message:
      "샘플 모드입니다. 에이전트 연결 및 작업 큐는 아직 실제로 연동되지 않았습니다.",
    at: "2026-11-14T00:00:00.000Z",
  },
];
