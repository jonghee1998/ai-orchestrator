// Pure view-model for the live collaboration progress dashboard (issue #42).
// Inputs are the existing read contracts: GET /api/runs and GET /api/collaboration.
// Anything the APIs do not provide is surfaced as null -> rendered as "unknown/unverified". Never invented.

export interface RunRow {
  dispatchId: string; issueNumber: number; agent: string; attempt: number; status: string; verified: boolean;
  submission: string | null; lastActivityAt: string | null; lastError: string | null;
  evidence: { kind: string; url: string; at?: string }[]; latency: { ackMs?: number; startMs?: number } | null;
  collaboration: { workflowId: string; cycle: number; step: string; repo: string; baseBranch: string; baseSha: string; workBranch: string; targetSha: string; prNumber?: number } | null;
  execution: { exitCode: number; summary: string; headSha: string; tests: { command: string; exitCode: number }[] } | null;
}
export interface WorkflowRow {
  id: string; stage: string; cycle: number; feedback: string; updatedAt: string; dispatchId?: string;
  assignment: { repo: string; issueNumber: number; baseBranch: string; baseSha: string; workBranch: string; claudeAgent: string; sourcePr: number };
  latest?: { number: number; headSha: string; headBranch: string; url: string; open: boolean };
  history: { at: string; action: string; dispatchId?: string; sha?: string; detail?: string }[];
}
export type Bucket = "queued" | "running" | "completed" | "blocked" | "unknown";
export const BUCKET_LABEL: Record<Bucket, string> = { queued: "대기", running: "실행 중", completed: "완료", blocked: "차단/실패", unknown: "미확인(unknown)" };

export function bucketOf(status: string): Bucket {
  switch (status) {
    case "queued": return "queued";
    case "acknowledged": case "running": return "running";
    case "succeeded": return "completed";
    case "failed": case "timeout": return "blocked";
    default: return "unknown"; // "unknown" (dispatched without ACK) and anything unrecognized
  }
}
export interface Card {
  dispatchId: string; agent: string; bucket: Bucket; status: string; task: string; issueNumber: number; repo: string | null;
  branch: string | null; sha: string | null; shaKind: "head" | "target" | null;
  ack: { text: string; verified: boolean }; lastEvent: string | null;
  links: { label: string; url: string }[]; findings: string | null; nextAction: string; error: string | null;
}
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const safeUrl = (u: string) => /^https:\/\/(github\.com|[\w.-]+\.github\.com)\//.test(u);

export function nextAction(r: RunRow, w?: WorkflowRow): string {
  if (w) {
    if (w.stage === "pm") return "PM 검수 대기 (approve / revise)";
    if (w.stage === "approved") return "승인됨 — 추가 작업 없음";
    if (w.stage === "blocked") return "차단됨 — PM 확인 필요";
  }
  switch (bucketOf(r.status)) {
    case "queued": return "제출 대기 (게이트 통과 시 dispatch)";
    case "running": return "에이전트 실행 중 — 완료 콜백 대기";
    case "completed": return "결과 검수";
    case "blocked": return "원인 확인 후 명시적 재시도 필요";
    default: return r.submission === "unknown" ? "ACK 유실 가능 — 자동 재시도 안 함, 수동 확인" : "ACK 미확인 — 수신 여부 확인 필요";
  }
}
export function buildCards(runs: RunRow[], workflows: WorkflowRow[]): Card[] {
  const wf = new Map(workflows.map((w) => [w.id, w]));
  return [...runs].sort((a, b) => Date.parse(b.lastActivityAt ?? "") - Date.parse(a.lastActivityAt ?? "") || 0).map((r) => {
    const c = r.collaboration, w = c ? wf.get(c.workflowId) : undefined;
    const repo = c?.repo ?? w?.assignment.repo ?? null;
    const links: Card["links"] = [];
    if (repo && REPO.test(repo)) {
      links.push({ label: `Issue #${r.issueNumber}`, url: `https://github.com/${repo}/issues/${r.issueNumber}` });
      const pr = r.collaboration?.prNumber ?? w?.latest?.number;
      if (pr) links.push({ label: `PR #${pr}`, url: `https://github.com/${repo}/pull/${pr}` });
    }
    for (const e of r.evidence ?? []) if (safeUrl(e.url)) links.push({ label: e.kind, url: e.url });
    const ex = r.execution;
    const failed = ex ? ex.tests.filter((t) => t.exitCode !== 0).length : 0;
    return {
      dispatchId: r.dispatchId, agent: r.agent, bucket: bucketOf(r.status), status: r.status, issueNumber: r.issueNumber, repo,
      task: c ? `#${r.issueNumber} · ${c.step} · cycle ${c.cycle}` : `#${r.issueNumber} (attempt ${r.attempt})`,
      branch: c?.workBranch ?? null,
      sha: ex?.headSha ?? c?.targetSha ?? null, shaKind: ex ? "head" : c ? "target" : null,
      ack: r.verified
        ? { verified: true, text: `검증됨 (agent 콜백)${r.latency?.ackMs !== undefined ? ` · ACK ${Math.round(r.latency.ackMs / 1000)}s` : ""}` }
        : { verified: false, text: `미검증 — provider ACK 없음${r.submission ? ` (submission: ${r.submission})` : ""}` },
      lastEvent: r.lastActivityAt, links, error: r.lastError,
      findings: ex ? `exit ${ex.exitCode}${ex.tests.length ? ` · 테스트 ${ex.tests.length - failed}/${ex.tests.length} 통과` : " · 테스트 기록 없음"} — ${ex.summary}` : w?.feedback ? `PM 피드백: ${w.feedback}` : null,
      nextAction: nextAction(r, w),
    };
  });
}
export function summarize(cards: Card[]): Record<Bucket, number> {
  const s: Record<Bucket, number> = { queued: 0, running: 0, completed: 0, blocked: 0, unknown: 0 };
  for (const c of cards) s[c.bucket]++;
  return s;
}
export const parseRuns = (_s: number, b: unknown): RunRow[] | "unconfigured" | null => {
  const o = b as { mode?: string; runs?: unknown } | null;
  if (!o) return null;
  if (o.mode === "unconfigured") return "unconfigured";
  return o.mode === "live" && Array.isArray(o.runs) ? (o.runs as RunRow[]) : null;
};
export const parseWorkflows = (_s: number, b: unknown): WorkflowRow[] | "unconfigured" | null => {
  const o = b as { workflows?: unknown; error?: string } | null;
  if (!o) return null;
  if (o.error === "store_unconfigured") return "unconfigured";
  return Array.isArray(o.workflows) ? (o.workflows as WorkflowRow[]) : null;
};
