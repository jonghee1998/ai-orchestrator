// Issue #60 — read-only GitHub collaboration evidence (issue → ACK → PR → review → revision → next action).
// Everything here is derived from GitHub REST payloads only. It is GitHub evidence, NOT runtime proof:
// comment authorship is the GitHub login (routines post as the owner account), so agent identity in
// comment text is self-reported and is labelled as such. Nothing is invented; missing data stays absent.

import type {
  CommentEvidence, DecisionSource, EvidenceKind, IssueEvidence, NextAction, PullEvidence, RawComment, RawIssue, RawPull, RawReview, RawCommit, ReviewEvidence, EvidenceReport, StackRef, Acceptance,
} from "./evidence-types";
export type * from "./evidence-types";
import { classify } from "../workflow/lifecycle";

const labelNames = (i: RawIssue) => i.labels.map((l) => (typeof l === "string" ? l : l.name)).filter((l): l is string => typeof l === "string");
function namespaced(labels: string[], prefix: string): string {
  const m = labels.filter((l) => l.startsWith(prefix));
  return m.length === 1 ? m[0].slice(prefix.length) : m.length === 0 ? "none" : "ambiguous";
}
export function issueNumberFromUrl(url: string): number | undefined {
  const m = /\/issues\/(\d+)$/.exec(url);
  return m ? Number(m[1]) : undefined;
}
/** First meaningful line, stripped of markdown emphasis/heading markers. */
export function headline(body: string | null | undefined): string {
  const line = (body ?? "").replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/).map((l) => l.replace(/^[#>\s*_`-]+|[*_`]+$/g, "").replace(/\*\*/g, "").trim()).find((l) => l.length > 0) ?? "";
  return line.slice(0, 160);
}
const PENDING_APPROVAL = new RegExp([
  "승인\\s*(?:이\\s*)?(?:필요|대기|요청|전|후|여부|예정|바랍니다|해\\s*주|부탁|검토|진행\\s*중|기다)",
  "(?:승인을?|승인)\\s*(?:받아야|기다리|요청)",
  "\\b(?:await(?:s|ing)?|pending|waiting\\s+(?:for|on)|needs?|requires?|required|request(?:s|ed|ing)?|seeking|for)\\s+(?:\\w+\\s+)?approv",
  "\\bapproval\\s+(?:is\\s+)?(?:required|needed|pending|requested)",
  "\\bplease\\s+approve\\b",
  "\\bto\\s+be\\s+approved\\b",
].join("|"), "i");
const NEGATED_APPROVAL = /\b(?:not|no|un|never)\s*(?:yet\s+)?approv|미승인|승인\s*(?:불가|거부|거절|보류|취소|안\s*됨|하지\s*않|되지\s*않)|비승인/i;
const AFFIRMATIVE_APPROVAL = /\b(?:approved|LGTM)\b|^\W*(?:verdict\s*:\s*)?approve\b|승인\s*(?:함|합니다|했습니다|하였습니다|했|완료|됨|되었습니다|처리)|^\W*(?:PM\s*)?승인\s*(?:$|[—–:\-.!✅])/i;
/** Classifies a comment by its headline only — body prose like "no merge until approved" must not count. */
export function classifyComment(body: string | null | undefined): EvidenceKind {
  // Parentheticals carry dedupe keys like "(dedupe pr56:…:opus:revise:1)" — never a decision by themselves.
  const raw = headline(body);
  if (/\bACK\b/.test(raw)) return "ack";
  const h = raw.replace(/\([^)]*\)/g, " ");
  if (/\bcompletion\b|완료 보고/i.test(h)) return "completion";
  if (/\b(changes requested|request(?:ing)? changes|revise|revision required|needs revision)\b|수정 요청|재작업/i.test(h)) return "revise";
  // Only an affirmative verdict counts. Pending/required/requested approval language ("소유자 승인 필요",
  // "승인 대기", "awaiting approval", "please approve") is status, never a decision (PR #61 P2).
  if (!PENDING_APPROVAL.test(h) && !NEGATED_APPROVAL.test(h) && AFFIRMATIVE_APPROVAL.test(h)) return "approve";
  if (/\breview\b|검수|리뷰/i.test(h)) return "review";
  return "other";
}
export function toComment(c: RawComment): CommentEvidence {
  const login = c.user?.login ?? "unknown";
  return { id: c.id, url: c.html_url, at: c.created_at, login, bot: c.user?.type === "Bot" || login.endsWith("[bot]"), kind: classifyComment(c.body), headline: headline(c.body) };
}

// Keyword followed by one OR MORE refs: `Refs #104 #99 #102`, `Refs #102, #99`, `Closes #1 and #2`.
const KEYWORD_REF = /\b(?:refs?|close[sd]?|fix(?:e[sd])?|resolve[sd]?|issue)\b\s*:?\s*((?:#\d+(?:\s*(?:,|and|&)?\s*)?)+)/gi;
const ANY_REF = /#(\d+)/g;
/** Issue numbers a PR claims to address: any `#N` in its title, keyword-gated `#N` in its body. */
export function pullIssueRefs(p: Pick<RawPull, "title" | "body">): { title: Set<number>; body: Set<number> } {
  const title = new Set([...p.title.matchAll(ANY_REF)].map((m) => Number(m[1])));
  const body = new Set([...(p.body ?? "").matchAll(KEYWORD_REF)].flatMap((m) => [...m[1].matchAll(ANY_REF)].map((n) => Number(n[1]))));
  return { title, body };
}
/** PR numbers an issue comment (or issue body, #65) points at: `/pull/N` URLs, `PR #N` / `PR: #N` mentions,
 *  or the compact upper-case `PR63` form. Explicit references only — branch/SHA similarity is never used. */
export function commentPullRefs(body: string | null | undefined): Set<number> {
  const s = (body ?? "").replace(/<!--[\s\S]*?-->/g, " ");
  const out = new Set<number>();
  for (const m of s.matchAll(/\/pull\/(\d+)\b/g)) out.add(Number(m[1]));
  for (const m of s.matchAll(/\bPR\s*:?\s*#(\d+)/gi)) out.add(Number(m[1]));
  for (const m of s.matchAll(/\bPR(\d+)\b/g)) out.add(Number(m[1]));
  return out;
}

/** Structured PM markers in comment bodies (written by the GPT PM workflow). */
export interface PmMarker { kind: "review_request" | "revise_request"; pr: number; sha: string; agent?: string; round: number; url: string; at: string }
const PM_MARKER = /<!--\s*gpt-pm-(event-state:v1\s+|followup:)pr(\d+):([a-f0-9]{40}):(?:([a-z-]+):)?(review|revise):(\d+)\s*-->/g;
export function pmMarkers(c: RawComment): PmMarker[] {
  return [...(c.body ?? "").matchAll(PM_MARKER)].map((m) => ({
    kind: m[5] === "revise" ? "revise_request" as const : "review_request" as const,
    pr: Number(m[2]), sha: m[3], agent: m[4], round: Number(m[6]), url: c.html_url, at: c.created_at,
  }));
}

/** PM acceptance marker. SELF-REPORTED by whoever posts it (all routines share the owner login): it is a record, not
 *  authentication, and must never authorize execution, merge or deploy. Binds issue, PR, exact SHA and target branch. */
const PM_ACCEPT = /<!--\s*gpt-pm-accept:v1\s+issue(\d+):pr(\d+):([a-f0-9]{40}):target=([A-Za-z0-9_./-]+)\s*-->/g;
export function pmAcceptances(c: RawComment): Acceptance[] {
  return [...(c.body ?? "").matchAll(PM_ACCEPT)].map((m) => ({ issue: Number(m[1]), pr: Number(m[2]), sha: m[3], target: m[4], at: c.created_at, url: c.html_url, by: c.user?.login ?? "unknown" }));
}

const FULL_SHA = /\b[a-f0-9]{40}\b/g;
/** The one full commit SHA a comment names, or undefined when it names none or several (ambiguous). */
export function boundSha(body: string | null | undefined): string | undefined {
  const shas = new Set((body ?? "").replace(/<!--[\s\S]*?-->/g, " ").toLowerCase().match(FULL_SHA) ?? []);
  return shas.size === 1 ? [...shas][0] : undefined;
}

const REVIEW_DECISION: Record<string, "approve" | "revise" | undefined> = { APPROVED: "approve", CHANGES_REQUESTED: "revise" };
export function pullEvidence(p: RawPull, linkedBy: PullEvidence["linkedBy"], detail?: { reviews: RawReview[]; commits: RawCommit[]; commitsTruncated: boolean }, conversation: RawComment[] = [], markers: PmMarker[] = [], stacked: RawPull[] = []): PullEvidence {
  const comments = conversation.map(toComment).sort((a, b) => a.at.localeCompare(b.at));
  const commentSha = new Map(conversation.map((c) => [c.id, boundSha(c.body)]));
  const reviews: ReviewEvidence[] = (detail?.reviews ?? [])
    .filter((r) => typeof r.submitted_at === "string")
    .map((r) => ({ id: r.id, url: r.html_url, at: r.submitted_at as string, login: r.user?.login ?? "unknown", state: r.state, commit: r.commit_id ?? undefined }))
    .sort((a, b) => a.at.localeCompare(b.at));
  const commitTimes = (detail?.commits ?? []).map((c) => c.commit?.committer?.date).filter((d): d is string => typeof d === "string").sort();
  const signals = [
    // Official reviews keep their commit_id so approval freshness is SHA-bound, not timestamp-bound (PR #61 P1).
    ...reviews.flatMap((r) => (REVIEW_DECISION[r.state] ? [{ kind: REVIEW_DECISION[r.state]!, at: r.at, source: "review" as const, by: r.login, url: r.url, sha: r.commit }] : [])),
    ...comments.flatMap((c) => (c.kind === "approve" || c.kind === "revise" ? [{ kind: c.kind, at: c.at, source: "comment" as const, by: c.login, url: c.url, sha: commentSha.get(c.id) }] : [])),
    ...markers.filter((m) => m.kind === "revise_request").map((m) => ({ kind: "revise" as const, at: m.at, source: "pm-marker" as const, by: m.agent ? `PM→${m.agent}` : "PM", url: m.url, sha: m.sha })),
  ].sort((a, b) => a.at.localeCompare(b.at)) as Array<{ kind: "approve" | "revise"; at: string; source: DecisionSource; by: string; url?: string; sha?: string }>;
  const after = (at: string) => commitTimes.filter((t) => t > at).length;
  // A revision may land as a new PR stacked on this PR's head branch (the repo's usual pattern).
  const stackedAfter = (at: string) => stacked.filter((q) => (q.updated_at ?? "") > at).map((q) => q.number).sort((a, b) => a - b);
  const addressed = (s: { at: string; sha?: string }) => after(s.at) > 0 || (!!s.sha && s.sha !== p.head.sha) || stackedAfter(s.at).length > 0;
  const last = signals[signals.length - 1];
  const reviewRequest = markers.filter((m) => m.kind === "review_request").sort((a, b) => a.at.localeCompare(b.at)).pop();
  // Official approval: latest review by a NON-author; must be APPROVED and bound to the current head. Author unknown → unprovable.
  const author = p.user?.login ?? undefined;
  const lastOfficial = author ? reviews.filter((r) => r.login !== author && r.login !== "unknown" && REVIEW_DECISION[r.state]).pop() : undefined;
  const officialApproval = detail && lastOfficial && lastOfficial.state === "APPROVED" && lastOfficial.commit?.toLowerCase() === p.head.sha.toLowerCase()
    ? { by: lastOfficial.login, at: lastOfficial.at, sha: lastOfficial.commit!.toLowerCase(), url: lastOfficial.url } : undefined;
  const botReviewOnHead = reviews.filter((r) => r.login.endsWith("[bot]") && r.commit === p.head.sha).pop();
  return {
    number: p.number, url: p.html_url, title: p.title,
    state: p.merged_at ? "merged" : p.state === "open" ? "open" : "closed", draft: !!p.draft,
    base: p.base.ref, head: p.head.ref, headSha: p.head.sha, linkedBy,
    ...(author ? { author } : {}), ...(p.merged_at ? { mergedAt: p.merged_at } : {}), ...(officialApproval ? { officialApproval } : {}),
    commits: { count: commitTimes.length, truncated: detail?.commitsTruncated ?? false, latestAt: commitTimes[commitTimes.length - 1] },
    reviews, comments,
    revisions: detail ? signals.filter((s) => s.kind === "revise" && addressed(s)).length : 0,
    decision: last && detail ? (() => {
      const headMatch = !last.sha ? "unknown" as const : last.sha.toLowerCase() === p.head.sha.toLowerCase() ? "exact" as const : "stale" as const;
      return { kind: last.kind, at: last.at, source: last.source, by: last.by, url: last.url, commitsAfter: after(last.at), sha: last.sha, headMatch, headMoved: headMatch === "stale", stackedPulls: stackedAfter(last.at) };
    })() : undefined,
    reviewRequest: reviewRequest ? { at: reviewRequest.at, url: reviewRequest.url, sha: reviewRequest.sha, onHead: reviewRequest.sha === p.head.sha } : undefined,
    botReviewOnHead: botReviewOnHead ? { at: botReviewOnHead.at, login: botReviewOnHead.login, url: botReviewOnHead.url } : undefined,
    detail: detail ? "loaded" : "skipped",
  };
}

const AGENT_NAMES: Record<string, string> = { opus: "Claude Opus", claude: "Claude Sonnet", codex: "Codex" };
/** `closedVerified`: the lifecycle (same model as the workspace) proved the closed issue complete. Otherwise a closed
 *  issue is never "done" here — it is `closed_unverified`, matching lifecycle phase `unknown`. */
export function nextAction(i: { state: "open" | "closed"; agent: string; status: string; acks: unknown[]; pulls: PullEvidence[] }, closedVerified = false): NextAction {
  const agent = AGENT_NAMES[i.agent] ?? `agent:${i.agent}`;
  if (i.state === "closed") return closedVerified ? { code: "done", label: "완료 (완료 기준 충족 확인됨)", actor: "-" } : { code: "closed_unverified", label: "이슈 닫힘 — 완료 기준 확인되지 않음", actor: "PM" };
  if (i.status === "blocked") return { code: "blocked", label: "차단 — 이슈 코멘트의 차단 사유 해소 필요", actor: "PM/소유자" };
  if (i.agent === "none" || i.agent === "ambiguous" || i.status === "none" || i.status === "ambiguous")
    return { code: "triage", label: "agent:/status: 라벨 정리 필요", actor: "PM" };
  const pr = [...i.pulls].sort((a, b) => (a.state === "open" ? 0 : 1) - (b.state === "open" ? 0 : 1) || b.number - a.number)[0];
  if (!pr) {
    if (!i.acks.length && (i.status === "ready" || i.status === "queued")) return { code: "await_ack", label: `${agent} 루틴 ACK 대기`, actor: agent };
    if (i.status === "review") return { code: "await_pr", label: "검수 상태이나 연결된 PR 증거 없음 — 완료 보고 확인", actor: "PM" };
    return { code: "agent_implementing", label: `${agent} 구현 중 (PR 미생성)`, actor: agent };
  }
  if (pr.state === "merged") return { code: "pr_merged", label: `PR #${pr.number} 병합됨 — 이슈 종료 판단`, actor: "PM" };
  const d = pr.decision;
  if (d?.kind === "revise" && d.commitsAfter === 0 && !d.headMoved && d.stackedPulls.length)
    return { code: "pm_rereview", label: `PR #${pr.number} 수정은 스택 PR ${d.stackedPulls.map((n) => `#${n}`).join(", ")}에서 진행 — 해당 PR 검수`, actor: "PM/Codex" };
  if (d?.kind === "revise") return d.commitsAfter > 0 || d.headMoved
    ? { code: "pm_rereview", label: `PR #${pr.number} 수정 반영됨(${d.headMoved ? "head 변경" : `커밋 ${d.commitsAfter}건`}) — 재검수`, actor: "PM/Codex" }
    : { code: "agent_revision", label: `PR #${pr.number} 수정 요청 반영 대기`, actor: agent };
  if (d?.kind === "approve") {
    // Approval counts only when bound to the exact current head SHA (cherry-pick/rebase can keep older timestamps).
    if (d.headMatch === "stale") return { code: "pm_rereview", label: `PR #${pr.number} 승인 SHA ${d.sha!.slice(0, 7)} ≠ 현재 head ${pr.headSha.slice(0, 7)} — 재검수`, actor: "PM/Codex" };
    if (d.headMatch === "unknown") return { code: "pm_decision", label: `PR #${pr.number} 승인 대상 SHA 확인 불가 — 현재 head ${pr.headSha.slice(0, 7)} 기준 PM 판정 필요`, actor: "PM" };
    return d.commitsAfter > 0
      ? { code: "pm_rereview", label: `PR #${pr.number} 승인 후 새 커밋 ${d.commitsAfter}건 — 재검수`, actor: "PM/Codex" }
      : { code: "owner_merge_decision", label: `PR #${pr.number} 현재 head ${pr.headSha.slice(0, 7)} 승인됨 — 소유자 병합/배포 승인 필요`, actor: "소유자" };
  }
  if (pr.botReviewOnHead) return { code: "pm_decision", label: `PR #${pr.number} ${pr.botReviewOnHead.login} 리뷰 완료(현재 head) — PM 판정 필요`, actor: "PM" };
  if (pr.reviewRequest?.onHead) return { code: "codex_review", label: `PR #${pr.number} Codex 리뷰 요청됨(현재 head) — 결과 대기`, actor: "Codex" };
  return { code: "pm_review", label: `PR #${pr.number} 검수 대기`, actor: "PM/Codex" };
}

export interface EvidenceInput {
  repo: string; generatedAt: string;
  issues: RawIssue[]; pulls: RawPull[]; comments: RawComment[];
  pullDetail: Map<number, { reviews: RawReview[]; commits: RawCommit[]; commitsTruncated: boolean }>;
  commentsTruncated: boolean; pullsTruncated: boolean; issuesTruncated?: boolean;
}
/** Which PRs each non-PR issue is linked to (deterministic, numeric order). */
export function linkPulls(issues: RawIssue[], pulls: RawPull[], comments: RawComment[]): Map<number, Map<number, Set<PullEvidence["linkedBy"][number]>>> {
  const issueNums = new Set(issues.filter((i) => !i.pull_request).map((i) => i.number));
  const pullNums = new Set(pulls.map((p) => p.number));
  const links = new Map<number, Map<number, Set<PullEvidence["linkedBy"][number]>>>();
  const add = (issue: number, pr: number, how: PullEvidence["linkedBy"][number]) => {
    if (!issueNums.has(issue) || !pullNums.has(pr)) return;
    const m = links.get(issue) ?? new Map(); links.set(issue, m);
    const s = m.get(pr) ?? new Set(); m.set(pr, s); s.add(how);
  };
  for (const p of pulls) {
    const r = pullIssueRefs(p);
    r.title.forEach((n) => add(n, p.number, "title"));
    r.body.forEach((n) => add(n, p.number, "body"));
  }
  // #65: the issue's own body/title can name its PR explicitly (e.g. #64 → "…/pull/63#issuecomment-…", "verified PR63").
  for (const i of issues) if (!i.pull_request) {
    commentPullRefs(i.body).forEach((pr) => add(i.number, pr, "issue-body"));
    commentPullRefs(i.title).forEach((pr) => add(i.number, pr, "issue-body"));
  }
  for (const c of comments) {
    const n = issueNumberFromUrl(c.issue_url);
    if (n === undefined) continue;
    commentPullRefs(c.body).forEach((pr) => add(n, pr, "issue-comment"));
    pmMarkers(c).forEach((m) => add(n, m.pr, "issue-comment"));
  }
  return links;
}

const toRef = (p: RawPull, explicit: boolean): StackRef => ({
  number: p.number, state: p.merged_at ? "merged" : p.state === "open" ? "open" : "closed", base: p.base.ref, head: p.head.ref, headSha: p.head.sha,
  ...(p.merged_at ? { mergedAt: p.merged_at } : {}), explicit,
});
/** Every repo PR stacked on a seed PR (Q.base === P.head, transitive), plus the seeds. Linked or not: up-stack PRs count. */
export function stackUniverse(seeds: StackRef[], all: StackRef[]): StackRef[] {
  const out = new Map(seeds.map((r) => [r.number, r]));
  let frontier = seeds;
  while (frontier.length) {
    const next = all.filter((q) => !out.has(q.number) && frontier.some((p) => q.base === p.head && q.head !== p.head));
    next.forEach((q) => out.set(q.number, q)); frontier = next;
  }
  return [...out.values()].sort((a, b) => a.number - b.number);
}

const toReason = (r: string | null | undefined) => (r === "completed" || r === "not_planned" || r === "duplicate" ? r : r ? ("unknown" as const) : undefined);
export function buildEvidence(input: EvidenceInput): EvidenceReport {
  const byThread = new Map<number, RawComment[]>();
  for (const c of input.comments) {
    const n = issueNumberFromUrl(c.issue_url);
    if (n === undefined) continue;
    const list = byThread.get(n) ?? []; list.push(c); byThread.set(n, list);
  }
  const links = linkPulls(input.issues, input.pulls, input.comments);
  const markersByPr = new Map<number, PmMarker[]>();
  for (const c of input.comments) for (const m of pmMarkers(c)) { const l = markersByPr.get(m.pr) ?? []; l.push(m); markersByPr.set(m.pr, l); }
  const pullsByNum = new Map(input.pulls.map((p) => [p.number, p]));
  const seen = new Set<number>();
  const issues = input.issues
    .filter((i) => !i.pull_request && !seen.has(i.number) && seen.add(i.number))
    .sort((a, b) => b.number - a.number)
    .map((i): IssueEvidence => {
      const labels = labelNames(i);
      const own = (byThread.get(i.number) ?? []).map(toComment).sort((a, b) => a.at.localeCompare(b.at));
      const pulls = [...(links.get(i.number) ?? new Map()).entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([n, how]) => pullEvidence(pullsByNum.get(n)!, [...how].sort() as PullEvidence["linkedBy"], input.pullDetail.get(n), byThread.get(n) ?? [], markersByPr.get(n) ?? [],
          input.pulls.filter((q) => q.number !== n && q.base.ref === pullsByNum.get(n)!.head.ref)));
      const explicitNums = [...(links.get(i.number) ?? new Map<number, Set<string>>()).entries()].filter(([, how]) => ["title", "body", "issue-body"].some((h) => how.has(h as never))).map(([n]) => n);
      const allRefs = input.pulls.map((q) => toRef(q, explicitNums.includes(q.number)));
      const stack = stackUniverse(allRefs.filter((r) => r.explicit).map((r) => ({ ...r, officialApproved: pulls.find((x) => x.number === r.number)?.officialApproval?.sha === r.headSha.toLowerCase() || undefined })), allRefs);
      const stackNums = new Set(stack.map((r) => r.number));
      const acceptances = [
        ...(byThread.get(i.number) ?? []).flatMap(pmAcceptances),
        ...[...stackNums, ...pulls.map((x) => x.number)].flatMap((n) => (byThread.get(n) ?? []).flatMap(pmAcceptances).filter((a) => a.pr === n)),
      ].filter((a) => a.issue === i.number && stackNums.has(a.pr));
      const partial = [
        ...(input.pullsTruncated ? ["pulls_truncated"] : []), ...(input.commentsTruncated ? ["comments_truncated"] : []),
        ...pulls.filter((x) => stackNums.has(x.number) && x.detail === "skipped").map((x) => `pull_detail_skipped:#${x.number}`),
        ...pulls.filter((x) => stackNums.has(x.number) && x.commits.truncated).map((x) => `commits_truncated:#${x.number}`),
      ];
      const base = {
        number: i.number, title: i.title, url: i.html_url, state: (i.state === "closed" ? "closed" : "open") as "open" | "closed",
        agent: namespaced(labels, "agent:"), status: i.state === "closed" ? "done" : namespaced(labels, "status:"),
        acks: own.filter((c) => c.kind === "ack"), completions: own.filter((c) => c.kind === "completion"), comments: own.length, pulls,
      };
      const closed = base.state === "closed";
      const rich = { ...base, stack, acceptances, partial };
      // Same lifecycle model as the workspace decides whether a closed issue is "done" (I8 — one model).
      const lc = closed ? classify({ status: base.status, dependsOn: [], issueState: "closed", stateReason: toReason(i.state_reason), description: i.body ?? undefined }, { ...rich, nextAction: nextAction(base) }, () => true) : undefined;
      return { ...rich, nextAction: nextAction(base, lc?.completion === "complete") };
    });
  return {
    source: "github", repo: input.repo, generatedAt: input.generatedAt, runtimeProof: "not_included",
    identityNote: "GitHub 로그인 기준 증거입니다. 에이전트 이름은 코멘트 본문의 자기 보고이며 런타임(세션 콜백) 증명이 아닙니다.",
    limits: {
      issues: issues.length, pulls: input.pulls.length, comments: input.comments.length,
      commentsTruncated: input.commentsTruncated, pullsTruncated: input.pullsTruncated, detailedPulls: input.pullDetail.size,
      issuesTruncated: input.issuesTruncated ?? false,
    },
    issues,
  };
}
