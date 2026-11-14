// 샘플 전용 타입 픽스처 — 실제 데이터가 아니다. 샘플 모드에서만 사용한다.
import type { QueueTask } from "./viewModel";

export const SAMPLE_TASKS: QueueTask[] = [
  { id: "S1", title: "[샘플] 백엔드 작업 큐 API", agent: "codex", status: "status:in-progress", dependsOn: [], url: "" },
  { id: "S2", title: "[샘플] 대시보드 UI", agent: "claude", status: "status:in-progress", dependsOn: [], url: "" },
  { id: "S3", title: "[샘플] UI-API 통합 검수", agent: "opus", status: "status:ready", dependsOn: ["S1", "S2"], url: "" },
  { id: "S4", title: "[샘플] 문서 정리", agent: "claude", status: "status:blocked", dependsOn: [], url: "" },
  { id: "S5", title: "[샘플] 담당 미정 작업", agent: "unknown", status: "???", dependsOn: ["S9"], url: "" },
  { id: "S6", title: "[샘플] 기초 설정", agent: "claude", status: "status:done", dependsOn: [], url: "" },
];
