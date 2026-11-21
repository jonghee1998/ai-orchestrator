import type { Collaboration } from "../runs/collaboration";
// 결정적 합성 픽스처 (#85). 실제 데이터가 아니며 모든 값은 고정 상수다(현재 시각/난수 미사용).
import { defaultControl, PRESETS } from "../control/model";
import { buildSnapshot } from "../control/service";
import { runView } from "../runs/run-trust";
import type { DispatchRecord } from "../runs/run-tracking";
import type { StoreData } from "../runs/store";
import type { WorkQueueTask } from "../github/work-queue";
import type { EvidenceReport, IssueEvidence } from "../github/evidence";
import type { Scenario } from "./mode";

export const DEMO_NOW = "2026-01-15T03:30:00.000Z"; // KST 2026-01-15 12:30:00 (고정)
const T = (m: number) => new Date(Date.parse(DEMO_NOW) - m * 60_000).toISOString();
const rec = (n: number, agent: string, status: DispatchRecord["status"], min: number, x: Partial<DispatchRecord> = {}): DispatchRecord => ({
  dispatchId: `demo-${n}`, issueNumber: 900 + n, agent, status, requestedAt: T(min + 15), attempt: 1, evidence: [], source: "none", lastActivityAt: T(min), ...x,
});

export function demoStore(scenario: Scenario): StoreData {
  const control = { ...defaultControl(), version: 7, updatedAt: T(60), preset: "all-enabled" as const, claudeProvider: true, agents: { ...PRESETS["all-enabled"].agents } };
  const records: Record<string, DispatchRecord> = {};
  if (scenario !== "empty") {
    for (const r of [
      rec(1, "claude-sonnet", "queued", 3, { issueNumber: 907 }),
      rec(2, "codex", "running", 2, { runId: "demo-run-2", source: "agent-callback", ackAt: T(8), startedAt: T(7), lastHeartbeatAt: T(2), dispatchedAt: T(9) }),
      rec(3, "claude-opus", "succeeded", 40, { runId: "demo-run-3", source: "agent-callback", finishedAt: T(40), execution: { exitCode: 0, summary: "[DEMO] 샘플 테스트 통과 보고", headSha: "a".repeat(40), tests: [{ command: "샘플: 상담 답변 형식 검사", exitCode: 0 }] }, evidence: [{ kind: "pr", url: "https://example.invalid/demo/pull/1", at: T(41) }] }),
      rec(4, "codex", "failed", 90, { lastError: "데모: 합성 오류 (실제 오류 아님)" }),
      rec(5, "claude-sonnet", "timeout", 150, { issueNumber: 906, lastError: "데모: ACK 시간 초과" }),
      rec(6, "claude-sonnet", "queued", 12, { issueNumber: 908, held: "agent_disabled" }),
    ]) records[r.dispatchId] = r;
  }
  return { records, events: {}, control, audit: scenario === "empty" ? [] : [{ at: T(60), actor: "demo", action: "preset", detail: "all-enabled (합성)", version: 7 }], blocked: {}, gateChecks: {} };
}
export const demoDashboard = (s: Scenario) => buildSnapshot(demoStore(s), DEMO_NOW);
export const demoRuns = (s: Scenario) => Object.values(demoStore(s).records).map(runView);

const PROJECTS = [
  { id: "sample-dashboard", name: "모바일 업무 대시보드", goal: "휴대폰에서 진행 상황과 다음 할 일을 쉽게 확인합니다." },
  { id: "sample-support", name: "고객 상담 도우미", goal: "자주 묻는 질문에 빠르고 일관된 답변을 제공합니다." },
  { id: "sample-report", name: "주간 보고서 자동화", goal: "매주 필요한 업무 보고서를 한곳에 정리합니다." },
];
const t = (id: string, title: string, agent: WorkQueueTask["agent"], status: string, project: number, dependsOn: string[] = []): WorkQueueTask => ({
  id, title: `[DEMO] ${title}`, agent, status, dependsOn, url: "", project: PROJECTS[project],
  issueState: status === "status:done" ? "closed" : "open", ...(status === "status:done" ? { stateReason: "completed" as const } : {}), description: `${title} — ${PROJECTS[project].goal} 샘플 요구사항이며 실제 실행하지 않습니다.\nCompletion type: nondeploy`,
});
export const demoQueue = (s: Scenario): WorkQueueTask[] => s === "empty" ? [] : [
  t("901", "알림 화면에 필요한 내용 정리", "unknown", "status:backlog", 0),
  t("902", "모바일 프로젝트 화면 만들기", "codex", "status:in-progress", 0),
  t("903", "상담 답변 초안 검수", "opus", "status:review", 1),
  t("904", "검수 의견을 답변에 반영", "codex", "status:in-progress", 1, ["903"]),
  t("905", "모바일 화면 구성안 확정", "claude", "status:done", 0),
  t("906", "상담 정책 확인 후 안내문 작성", "claude", "status:blocked", 1, ["999"]),
  t("907", "접근성 점검 시작 준비", "claude", "status:queued", 0),
  t("908", "자주 묻는 질문 분류", "claude", "status:ready", 1),
  t("909", "주간 보고서 항목 정리", "codex", "status:done", 2),
  t("910", "보고서 결과 검수 및 업무 종료", "opus", "status:done", 2),
];

const c = (id: number, kind: "ack" | "completion", min: number) => ({ id, url: `https://example.invalid/demo/comments/${id}`, at: T(min), login: "demo-agent", bot: true, kind, headline: kind === "ack" ? "ACK (합성)" : "완료 보고 (합성)" });
const issue = (n: number, title: string, state: "open" | "closed", status: string, code: IssueEvidence["nextAction"]["code"], label: string, extra: Partial<IssueEvidence> = {}): IssueEvidence => ({
  number: n, title: `[DEMO] ${title}`, url: "https://example.invalid/demo", state, agent: "claude", status, acks: [], completions: [], comments: 0, pulls: [], nextAction: { code, label, actor: "demo" }, ...extra,
});
export function demoEvidence(s: Scenario): EvidenceReport {
  const issues: IssueEvidence[] = s === "empty" ? [] : [
    issue(901, "알림 화면에 필요한 내용 정리", "open", "backlog", "await_ack", "업무 준비"),
    issue(902, "모바일 프로젝트 화면 만들기", "open", "in-progress", "agent_implementing", "구현 중", { acks: [c(1, "ack", 20)], comments: 1 }),
    issue(903, "상담 답변 초안 검수", "open", "review", "pm_review", "PM 검수", { acks: [c(2, "ack", 80)], completions: [c(3, "completion", 45)], comments: 2, pulls: [{ number: 1, url: "https://example.invalid/demo/pull/1", title: "[DEMO] 상담 답변 초안", state: "open", draft: false, base: "demo-base", head: "demo-work", headSha: "a".repeat(40), linkedBy: ["issue-comment"], commits: { count: 1, truncated: false }, reviews: [{ id: 101, at: T(43), login: "demo-reviewer", state: "APPROVED", commit: "a".repeat(40) }], comments: [], revisions: 0, detail: "loaded", decision: { kind: "approve", at: T(43), source: "review", by: "demo-reviewer", commitsAfter: 0, sha: "a".repeat(40), headMatch: "exact", headMoved: false, stackedPulls: [] } }] }),
    issue(904, "검수 의견을 답변에 반영", "open", "in-progress", "agent_revision", "수정 반영 중", { acks: [c(4, "ack", 120)], comments: 3 }),
    issue(905, "모바일 화면 구성안 확정", "closed", "done", "done", "완료", { acks: [c(5, "ack", 300)], completions: [c(6, "completion", 240)], comments: 2 }),
    issue(906, "상담 정책 확인 후 안내문 작성", "open", "blocked", "blocked", "막힘 (합성 오류)"),
    // Closed demo tasks need matching (empty-PR) evidence: completion fails closed without it (Issue #119).
    issue(909, "주간 보고서 항목 정리", "closed", "done", "done", "완료"),
    issue(910, "보고서 결과 검수 및 업무 종료", "closed", "done", "done", "완료"),
  ];
  return {
    source: "github", repo: "demo/synthetic", generatedAt: DEMO_NOW, runtimeProof: "not_included",
    identityNote: "데모 합성 데이터 — 실제 GitHub 아님",
    limits: { issues: issues.length, pulls: 0, comments: 0, commentsTruncated: false, pullsTruncated: false, detailedPulls: 0, issuesTruncated: false },
    issues: issues.map((i) => ({ ...i, agent: demoQueue(s).find((t) => t.id === String(i.number))?.agent ?? "unknown" })),
  };
}

export const demoReadiness = () => ({
  items: [
    { id: "database", label: "데이터베이스", state: "missing", detail: "데모 모드 — 실제 DB 미사용" },
    { id: "github", label: "GitHub", state: "missing", detail: "데모 모드 — 실제 GitHub 미사용" },
  ],
  releaseBlocked: true,
  github: { state: "unconfigured", repo: null, tokenSource: "none", openIssues: null },
  githubEvidence: { ready: false, scope: "github_read_only", runtimeVerified: false, queueReadable: false, reads: null, detail: "데모 합성 데이터" },
});

export const demoCollaborations = (s: Scenario): Collaboration[] => s === "empty" ? [] : [{
  id: "demo-workflow-902", cycle: 1, stage: "codex", dispatchId: "demo-2", updatedAt: T(2),
  assignment: { repo: "demo/synthetic", issueNumber: 902, baseBranch: "demo-base", baseSha: "a".repeat(40), sourcePr: 1,
    workBranch: "demo-work", claudeAgent: "claude-sonnet", instructions: "[DEMO] 합성 검수 작업", reviewCompletedPr: true },
  feedback: "[DEMO] 실제 에이전트 실행 없음",
  history: [{ at: T(9), action: "demo_assigned", dispatchId: "demo-2", detail: "[DEMO] 합성 이력" }],
}];
