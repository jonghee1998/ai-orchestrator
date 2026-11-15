// Issue #65 — pure projections of the GitHub EvidenceReport (#60) for /progress, /agents and /activity.
// These are GitHub evidence only (issue/PR/comment/review payloads). They are NEVER merged into the internal
// runtime counters (run store), never upgrade a runtime OFF/unknown state, and never invent values:
// - "done" is a closed issue or a merged PR, never a status:* label alone;
// - ACK/completion are comment self-reports by the GitHub login, labelled as such;
// - counts are only shown when the report was actually read (the caller renders non-ok states explicitly).
import type { CommentEvidence, EvidenceReport, IssueEvidence, NextActionCode, PullEvidence } from "./evidence";

export type GitHubStage = "await_ack" | "implementing" | "review" | "revision" | "owner_decision" | "blocked" | "triage" | "done";
export const GITHUB_STAGE_LABEL: Record<GitHubStage, string> = {
  await_ack: "ACK 대기", implementing: "구현 중", review: "검수/리뷰", revision: "수정 대기",
  owner_decision: "소유자 결정", blocked: "차단", triage: "라벨 정리", done: "완료(닫힘/병합)",
};
const STAGE_OF: Record<NextActionCode, GitHubStage> = {
  await_ack: "await_ack", agent_implementing: "implementing",
  await_pr: "review", pm_review: "review", pm_rereview: "review", codex_review: "review", pm_decision: "review",
  agent_revision: "revision", owner_merge_decision: "owner_decision", pr_merged: "done",
  blocked: "blocked", triage: "triage", done: "done",
};
export const stageOf = (i: Pick<IssueEvidence, "nextAction">): GitHubStage => STAGE_OF[i.nextAction.code] ?? "triage";

/** The PR the next action is about: open first, then highest number (same rule as evidence.nextAction). */
export function primaryPull(i: Pick<IssueEvidence, "pulls">): PullEvidence | undefined {
  return [...i.pulls].sort((a, b) => (a.state === "open" ? 0 : 1) - (b.state === "open" ? 0 : 1) || b.number - a.number)[0];
}
const last = <T>(xs: T[]): T | undefined => xs[xs.length - 1];

export interface GitHubIssueRow {
  number: number; title: string; url: string; agent: string; statusLabel: string; stage: GitHubStage;
  ack: CommentEvidence | null; completion: CommentEvidence | null;
  pull: { number: number; url: string; state: PullEvidence["state"]; headSha: string; review: string } | null;
  nextAction: string; actor: string;
  /** #67: GitHub issue state. An open issue can be in stage "done" (PR merged, closure pending) — list by THIS. */
  issueState: "open" | "closed";
}
function reviewText(p: PullEvidence): string {
  if (p.detail === "skipped") return "리뷰 상세 미조회(unknown)";
  const d = p.decision;
  if (d) return `${d.kind === "approve" ? "승인" : "수정 요청"} · ${d.source} · SHA ${d.headMatch === "exact" ? "현재 head 일치" : d.headMatch === "stale" ? "이전 head" : "확인 불가"}`;
  if (p.botReviewOnHead) return `${p.botReviewOnHead.login} 리뷰(현재 head)`;
  if (p.reviewRequest) return `리뷰 요청됨(${p.reviewRequest.onHead ? "현재 head" : "이전 head"})`;
  return p.reviews.length ? `리뷰 ${p.reviews.length}건(판정 없음)` : "리뷰 없음";
}
export interface GitHubProgress {
  repo: string; generatedAt: string;
  /** Within the read bounds; a lower bound when `coverage.issuesTruncated`. */
  total: number; open: number;
  stages: Record<GitHubStage, number>; rows: GitHubIssueRow[];
}
/** #67: what the bounded reader could NOT see. Callers must disclose it and qualify counts / "none found" claims:
 *  issues truncated → issue totals are lower bounds; comments truncated → only the newest comments were read, so a
 *  missing ACK/completion may just be older than the window and ACK'd counts are lower bounds (un-ACK'd upper). */
export interface EvidenceCoverage { issuesTruncated: boolean; pullsTruncated: boolean; commentsTruncated: boolean; partial: boolean; notes: string[] }
export function evidenceCoverage(r: Pick<EvidenceReport, "limits">): EvidenceCoverage {
  const l = r.limits;
  const issuesTruncated = l.issuesTruncated === true, pullsTruncated = l.pullsTruncated === true, commentsTruncated = l.commentsTruncated === true;
  const notes: string[] = [];
  if (issuesTruncated) notes.push(`이슈 목록 상한 도달(최근 갱신 ${l.issues}개까지) — 오래된 이슈 누락, 이슈 수는 최소값`);
  if (pullsTruncated) notes.push(`PR 목록 상한 도달(${l.pulls}개) — 오래된 PR 연결 누락 가능`);
  if (commentsTruncated) notes.push(`코멘트 상한 도달(최근 ${l.comments}건만) — 이전 ACK/완료보고는 보이지 않을 수 있음`);
  return { issuesTruncated, pullsTruncated, commentsTruncated, partial: notes.length > 0, notes };
}
/** "None found" wording that does not overclaim when the source was truncated. */
export const absence = (what: string, truncated: boolean) => (truncated ? `${what} 조회 범위 내 없음(코멘트 잘림 — 이전 기록 있을 수 있음)` : `${what} 없음`);
/** Count wording: lower bound ("≥n") when the source was truncated. */
export const atLeast = (n: number, truncated: boolean) => (truncated ? `≥${n}` : String(n));

export function githubProgress(r: EvidenceReport): GitHubProgress {
  const stages = Object.fromEntries(Object.keys(GITHUB_STAGE_LABEL).map((k) => [k, 0])) as Record<GitHubStage, number>;
  const rows = r.issues.map((i): GitHubIssueRow => {
    const stage = stageOf(i); stages[stage]++;
    const p = primaryPull(i);
    return {
      number: i.number, title: i.title, url: i.url, agent: i.agent, statusLabel: i.status, stage,
      ack: last(i.acks) ?? null, completion: last(i.completions) ?? null,
      pull: p ? { number: p.number, url: p.url, state: p.state, headSha: p.headSha, review: reviewText(p) } : null,
      nextAction: i.nextAction.label, actor: i.nextAction.actor, issueState: i.state,
    };
  });
  return { repo: r.repo, generatedAt: r.generatedAt, total: rows.length, open: r.issues.filter((i) => i.state === "open").length, stages, rows };
}

/** agent:* label value → internal agent key used by /api/dashboard. */
export const LABEL_TO_AGENT: Record<string, string> = { opus: "claude-opus", claude: "claude-sonnet", codex: "codex" };
export interface GitHubAgentRow {
  label: string; agentKey: string | null; issues: number; open: number; acked: number; unacked: number;
  lastAck: CommentEvidence | null; lastCompletion: CommentEvidence | null; openPulls: number; awaitingAgent: number;
}
export function githubAgents(r: EvidenceReport): GitHubAgentRow[] {
  const by = new Map<string, IssueEvidence[]>();
  for (const i of r.issues) { const l = by.get(i.agent) ?? []; l.push(i); by.set(i.agent, l); }
  const newest = (xs: CommentEvidence[]) => xs.sort((a, b) => a.at.localeCompare(b.at)).pop() ?? null;
  return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([label, list]) => {
    const open = list.filter((i) => i.state === "open");
    return {
      label, agentKey: LABEL_TO_AGENT[label] ?? null, issues: list.length, open: open.length,
      acked: open.filter((i) => i.acks.length > 0).length, unacked: open.filter((i) => i.acks.length === 0).length,
      lastAck: newest(list.flatMap((i) => i.acks)), lastCompletion: newest(list.flatMap((i) => i.completions)),
      openPulls: new Set(list.flatMap((i) => i.pulls.filter((p) => p.state === "open").map((p) => p.number))).size,
      awaitingAgent: open.filter((i) => i.nextAction.code === "agent_implementing" || i.nextAction.code === "agent_revision" || i.nextAction.code === "await_ack").length,
    };
  });
}

export type GitHubEventKind = "ack" | "completion" | "approve" | "revise" | "review" | "pr";
export interface GitHubEvent { at: string; kind: GitHubEventKind; url?: string; login: string; bot: boolean; issue: number; pull?: number; text: string }
/** Chronological GitHub events (newest first), de-duplicated by URL/id. Only classified signals — "other" chatter is skipped. */
export function githubActivity(r: EvidenceReport, limit = 40): GitHubEvent[] {
  const out: GitHubEvent[] = [];
  const seen = new Set<string>();
  const push = (key: string, e: GitHubEvent) => { if (!seen.has(key)) { seen.add(key); out.push(e); } };
  for (const i of r.issues) {
    for (const c of [...i.acks, ...i.completions]) push(`c${c.id}`, { at: c.at, kind: c.kind as GitHubEventKind, url: c.url, login: c.login, bot: c.bot, issue: i.number, text: c.headline });
    for (const p of i.pulls) {
      for (const c of p.comments) if (c.kind !== "other") push(`c${c.id}`, { at: c.at, kind: c.kind as GitHubEventKind, url: c.url, login: c.login, bot: c.bot, issue: i.number, pull: p.number, text: c.headline });
      for (const v of p.reviews) push(`r${v.id}`, { at: v.at, kind: v.state === "APPROVED" ? "approve" : v.state === "CHANGES_REQUESTED" ? "revise" : "review", url: v.url, login: v.login, bot: v.login.endsWith("[bot]"), issue: i.number, pull: p.number, text: `PR #${p.number} 리뷰 ${v.state}${v.commit ? ` @ ${v.commit.slice(0, 7)}` : ""}` });
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

/** Accepts only the live /api/evidence contract. Shared by /evidence, /progress, /agents and /activity. */
export function parseEvidenceResponse(_s: number, b: unknown): EvidenceReport | "unconfigured" | null {
  if (!b || typeof b !== "object") return null;
  const o = b as { mode?: unknown; report?: EvidenceReport };
  if (o.mode === "unconfigured") return "unconfigured";
  if (o.mode !== "live" || !o.report || o.report.source !== "github" || !Array.isArray(o.report.issues)) return null;
  return o.report;
}

// ---- Final mobile polish (#69): deterministic Korean summaries + remaining-vs-history split. No model API. ----
const SHA_RE = /\b[0-9a-f]{40}\b/gi;
/** Full 40-hex SHAs → 7 chars for compact display. The original text stays available (expandable) with the full SHA. */
export const shortenShas = (s: string) => s.replace(SHA_RE, (m) => m.slice(0, 7));

export const EVENT_KIND_LABEL: Record<GitHubEventKind, string> = { ack: "ACK", completion: "완료보고", approve: "승인", revise: "수정 요청", review: "리뷰", pr: "PR" };
/** Deterministic Korean one-liner for a known event type. Facts only (issue/PR number, login, short SHA) — nothing inferred. */
export function summarizeEvent(e: GitHubEvent): string {
  const who = e.login + (e.bot ? " (bot)" : "");
  const target = e.pull ? `PR #${e.pull}` : `이슈 #${e.issue}`;
  const sha = /@ ([0-9a-f]{7})/i.exec(e.text)?.[1];
  const at = sha ? ` (커밋 ${sha})` : "";
  switch (e.kind) {
    case "ack": return `${who}이(가) ${target}에 작업 시작(ACK)을 남김`;
    case "completion": return `${who}이(가) ${target}에 완료보고를 남김`;
    case "approve": return `${who}이(가) ${target}을(를) 승인${at}`;
    case "revise": return `${who}이(가) ${target}에 수정을 요청${at}`;
    case "review": return `${who}이(가) ${target}에 리뷰를 남김${at}`;
    case "pr": return `${target} 관련 활동 (${who})`;
    default: return `${target} 활동 (${who})`;
  }
}

/** /tasks: open issues are REMAINING work (incl. closure-pending: PR merged but issue still open — never shown as completed).
 *  Closed issues are HISTORY (completed). `reviewed` is evidence (decision on a PR), shown separately from the status label. */
export interface TaskSplitRow { number: number; title: string; url: string; agent: string; statusLabel: string; stage: GitHubStage; closurePending: boolean; reviewedExact: boolean; mergedPr: number | null }
export interface TaskSplit { remaining: TaskSplitRow[]; history: TaskSplitRow[] }
export function githubTaskSplit(r: EvidenceReport): TaskSplit {
  const remaining: TaskSplitRow[] = [], history: TaskSplitRow[] = [];
  for (const i of r.issues) {
    const stage = stageOf(i);
    const merged = i.pulls.filter((p) => p.state === "merged").sort((a, b) => b.number - a.number)[0];
    const reviewedExact = i.pulls.some((p) => p.decision?.kind === "approve" && p.decision.headMatch === "exact");
    const row: TaskSplitRow = { number: i.number, title: i.title, url: i.url, agent: i.agent, statusLabel: i.status, stage, closurePending: i.state === "open" && stage === "done", reviewedExact, mergedPr: merged?.number ?? null };
    (i.state === "open" ? remaining : history).push(row);
  }
  return { remaining, history };
}
