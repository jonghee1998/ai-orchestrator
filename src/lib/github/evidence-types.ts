// Evidence data types (split out of evidence.ts so lifecycle.ts and evidence.ts never import each other).
export type EvidenceKind = "ack" | "completion" | "approve" | "revise" | "review" | "other";
export type DecisionSource = "review" | "comment" | "pm-marker";

export interface RawUser { login?: string | null; type?: string | null }
export interface RawIssue {
  number: number; title: string; body: string | null; html_url: string; state?: string; state_reason?: string | null;
  labels: Array<string | { name?: string | null }>; pull_request?: unknown; updated_at?: string;
}
export interface RawComment { id: number; body?: string | null; html_url: string; issue_url: string; created_at: string; user?: RawUser | null }
export interface RawPull {
  number: number; title: string; body: string | null; html_url: string; state: string; draft?: boolean;
  merged_at?: string | null; updated_at?: string; user?: RawUser | null; head: { ref: string; sha: string }; base: { ref: string };
}
export interface RawReview { id: number; state: string; submitted_at?: string | null; commit_id?: string | null; html_url?: string; user?: RawUser | null }
export interface RawCommit { sha: string; commit?: { committer?: { date?: string | null } | null } | null }

export interface CommentEvidence { id: number; url: string; at: string; login: string; bot: boolean; kind: EvidenceKind; headline: string }
export interface ReviewEvidence { id: number; url?: string; at: string; login: string; state: string; commit?: string }
export interface PullEvidence {
  number: number; url: string; title: string; state: "open" | "closed" | "merged"; draft: boolean;
  base: string; head: string; headSha: string;
  /** PR author login (needed to ignore self-approval). Absent → official approval cannot be proven. */
  author?: string;
  /** ISO merge time; absent on a merged PR → merge ordering is unknown (fails closed). */
  mergedAt?: string;
  /** Official GitHub APPROVED review by a NON-author, bound to the current head SHA. Never set from comments or PM markers. */
  officialApproval?: { by: string; at: string; sha: string; url?: string };
  linkedBy: Array<"title" | "body" | "issue-body" | "issue-comment">;
  commits: { count: number; truncated: boolean; latestAt?: string };
  reviews: ReviewEvidence[]; comments: CommentEvidence[];
  /** Revision rounds: revise signals that were followed by at least one later commit. */
  revisions: number;
  /** Latest approve/revise signal. headMoved: a PM marker named a SHA that is no longer the PR head. */
  decision?: {
    kind: "approve" | "revise"; at: string; source: DecisionSource; by: string; url?: string; commitsAfter: number;
    /** SHA the decision is bound to: official review commit_id, PM marker SHA, or the single full SHA named in a comment. */
    sha?: string;
    /** exact = bound to the current head; stale = bound to another SHA; unknown = no SHA evidence. Timestamps never decide this. */
    headMatch: "exact" | "stale" | "unknown";
    /** = headMatch === "stale" (kept for display compatibility). */
    headMoved: boolean; stackedPulls: number[];
  };
  /** Latest PM "codex review" request marker; onHead = it names the current head SHA. */
  reviewRequest?: { at: string; url: string; sha: string; onHead: boolean };
  /** A bot (e.g. Codex connector) submitted a review on the current head SHA. */
  botReviewOnHead?: { at: string; login: string; url?: string };
  detail: "loaded" | "skipped";
}
export type NextActionCode =
  | "done" | "closed_unverified" | "blocked" | "await_ack" | "agent_implementing" | "await_pr" | "pm_review"
  | "agent_revision" | "pm_rereview" | "owner_merge_decision" | "pr_merged" | "triage" | "codex_review" | "pm_decision"
  | "stranded_stack" | "completed_open" | "acceptance_incomplete";
export interface NextAction { code: NextActionCode; label: string; actor: string }
export interface IssueEvidence {
  number: number; title: string; url: string; state: "open" | "closed"; agent: string; status: string;
  acks: CommentEvidence[]; completions: CommentEvidence[]; comments: number;
  pulls: PullEvidence[]; nextAction: NextAction;
  /** All repo PRs relevant to this issue: explicitly linked PRs plus everything stacked on them (Q.base === P.head, transitive). */
  stack?: StackRef[];
  /** PM acceptance markers naming THIS issue. Self-reported by the owner login; NOT GitHub approval and NOT authentication. */
  acceptances?: Acceptance[];
  /** Reasons the evidence that decides completion is partial (truncated / not collected). Non-empty → completion unknown. */
  partial?: string[];
}
/** A PR in the stack universe. `explicit` = linked by PR title/body/issue-body (not merely an issue-comment mention). */
export interface StackRef {
  number: number; state: PullEvidence["state"]; base: string; head: string; headSha: string; mergedAt?: string;
  explicit: boolean; officialApproved?: boolean;
}
/** `<!-- gpt-pm-accept:v1 issueN:prM:<sha40>:target=<branch> -->` — PM self-reported acceptance bound to issue/PR/SHA/target. */
export interface Acceptance { issue: number; pr: number; sha: string; target: string; at: string; url: string; by: string }
export interface EvidenceReport {
  source: "github"; repo: string; generatedAt: string;
  /** Session/runtime callbacks are intentionally not consulted here (Issue #59 deferred). */
  runtimeProof: "not_included";
  identityNote: string;
  limits: { issues: number; pulls: number; comments: number; commentsTruncated: boolean; pullsTruncated: boolean; detailedPulls: number;
    /** #67: the issue listing hit its page bound — older issues are omitted from every count. */
    issuesTruncated: boolean };
  issues: IssueEvidence[];
}
