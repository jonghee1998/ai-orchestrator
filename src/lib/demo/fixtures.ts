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
  dispatchId: `demo-${n}`, issueNumber: 900 + n, agent, status, requestedAt: T(min + 5), attempt: 1, evidence: [], source: "none", lastActivityAt: T(min), ...x,
});

export function demoStore(scenario: Scenario): StoreData {
  const control = { ...defaultControl(), version: 7, updatedAt: T(60), preset: "all-enabled" as const, claudeProvider: true, agents: { ...PRESETS["all-enabled"].agents } };
  const records: Record<string, DispatchRecord> = {};
  if (scenario !== "empty") {
    for (const r of [
      rec(1, "claude-sonnet", "queued", 3),
      rec(2, "codex", "running", 2, { runId: "demo-run-2", source: "agent-callback", ackAt: T(8), startedAt: T(7), lastHeartbeatAt: T(2), dispatchedAt: T(9) }),
      rec(3, "claude-opus", "succeeded", 40, { runId: "demo-run-3", source: "agent-callback", finishedAt: T(40), evidence: [{ kind: "pr", url: "https://example.invalid/demo/pull/1", at: T(41) }] }),
      rec(4, "codex", "failed", 90, { lastError: "데모: 합성 오류 (실제 오류 아님)" }),
      rec(5, "gpt", "timeout", 150, { lastError: "데모: ACK 시간 초과" }),
      rec(6, "claude-sonnet", "queued", 12, { held: "agent_disabled" }),
    ]) records[r.dispatchId] = r;
  }
  return { records, events: {}, control, audit: scenario === "empty" ? [] : [{ at: T(60), actor: "demo", action: "preset", detail: "all-enabled (합성)", version: 7 }], blocked: {}, gateChecks: {} };
}
export const demoDashboard = (s: Scenario) => buildSnapshot(demoStore(s), DEMO_NOW);
export const demoRuns = (s: Scenario) => Object.values(demoStore(s).records).map(runView);

const t = (id: string, title: string, agent: WorkQueueTask["agent"], status: string, dependsOn: string[] = []): WorkQueueTask => ({ id, title: `[DEMO] ${title}`, agent, status, dependsOn, url: "" });
export const demoQueue = (s: Scenario): WorkQueueTask[] => s === "empty" ? [] : [
  t("D1", "백로그 항목", "unknown", "status:backlog"),
  t("D2", "준비된 작업", "claude", "status:ready"),
  t("D3", "대기열 작업", "codex", "status:queued"),
  t("D4", "진행 중 작업", "claude", "status:in-progress"),
  t("D5", "검수 대기 작업", "opus", "status:review", ["D4"]),
  t("D6", "수정 요청 반영(revision)", "codex", "status:in-progress", ["D5"]),
  t("D7", "완료 작업", "claude", "status:done"),
  t("D8", "막힌 작업", "codex", "status:blocked", ["D9"]),
];

const c = (id: number, kind: "ack" | "completion", min: number) => ({ id, url: "https://example.invalid/demo", at: T(min), login: "demo-agent", bot: true, kind, headline: kind === "ack" ? "ACK (합성)" : "완료 보고 (합성)" });
const issue = (n: number, title: string, state: "open" | "closed", status: string, code: IssueEvidence["nextAction"]["code"], label: string, extra: Partial<IssueEvidence> = {}): IssueEvidence => ({
  number: n, title: `[DEMO] ${title}`, url: "https://example.invalid/demo", state, agent: "claude", status, acks: [], completions: [], comments: 0, pulls: [], nextAction: { code, label, actor: "demo" }, ...extra,
});
export function demoEvidence(s: Scenario): EvidenceReport {
  const issues: IssueEvidence[] = s === "empty" ? [] : [
    issue(901, "대기 작업", "open", "queued", "await_ack", "ACK 대기"),
    issue(902, "진행 작업", "open", "in-progress", "agent_implementing", "구현 중", { acks: [c(1, "ack", 20)], comments: 1 }),
    issue(903, "검수 작업", "open", "review", "pm_review", "PM 검수", { acks: [c(2, "ack", 80)], completions: [c(3, "completion", 45)], comments: 2 }),
    issue(904, "수정 요청", "open", "in-progress", "agent_revision", "수정 반영 중", { acks: [c(4, "ack", 120)], comments: 3 }),
    issue(905, "완료 작업", "closed", "done", "done", "완료", { acks: [c(5, "ack", 300)], completions: [c(6, "completion", 240)], comments: 2 }),
    issue(906, "오류 작업", "open", "blocked", "blocked", "막힘 (합성 오류)"),
  ];
  return {
    source: "github", repo: "demo/synthetic", generatedAt: DEMO_NOW, runtimeProof: "not_included",
    identityNote: "데모 합성 데이터 — 실제 GitHub 아님",
    limits: { issues: issues.length, pulls: 0, comments: 0, commentsTruncated: false, pullsTruncated: false, detailedPulls: 0, issuesTruncated: false },
    issues,
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
