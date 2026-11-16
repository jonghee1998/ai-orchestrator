import assert from "node:assert/strict";
import test from "node:test";
import { buildEvidence, classifyComment, commentPullRefs, pullIssueRefs, type RawComment, type RawIssue, type RawPull } from "./evidence";
import { EvidenceConfigurationError, EvidenceReadError, readGitHubEvidence } from "./evidence-reader";

const R = "o/r";
const issue = (n: number, labels: string[], state = "open", body: string | null = null): RawIssue =>
  ({ number: n, title: `Issue ${n}`, body, html_url: `https://github.com/${R}/issues/${n}`, state, labels });
const comment = (id: number, thread: number, body: string, at: string, login = "owner"): RawComment =>
  ({ id, body, html_url: `https://github.com/${R}/issues/${thread}#c${id}`, issue_url: `https://api.github.com/repos/${R}/issues/${thread}`, created_at: at, user: { login, type: login.endsWith("[bot]") ? "Bot" : "User" } });
const pull = (n: number, title: string, body: string | null = null, extra: Partial<RawPull> = {}): RawPull =>
  ({ number: n, title, body, html_url: `https://github.com/${R}/pull/${n}`, state: "open", head: { ref: "feat", sha: "a".repeat(40) }, base: { ref: "base" }, updated_at: "2026-01-01T00:00:00Z", ...extra });
const commit = (date: string) => ({ sha: "b".repeat(40), commit: { committer: { date } } });
const build = (issues: RawIssue[], pulls: RawPull[], comments: RawComment[], detail = new Map()) =>
  buildEvidence({ repo: R, generatedAt: "2026-01-02T00:00:00Z", issues, pulls, comments, pullDetail: detail, commentsTruncated: false, pullsTruncated: false });

test("classifies only the headline so body prose cannot fake a decision", () => {
  assert.equal(classifyComment("**Opus ACK — Issue57**\n- scope"), "ack");
  assert.equal(classifyComment("**Completion report (Opus)**"), "completion");
  assert.equal(classifyComment("Changes requested: fix P1"), "revise");
  assert.equal(classifyComment("Approved — LGTM"), "approve");
  assert.equal(classifyComment("Not approved yet"), "other");
  assert.equal(classifyComment("Status update\nNo merge until the PM has approved."), "other");
  assert.equal(classifyComment("Opus 작업 시작 (session ACK). Baseline x"), "ack");
  assert.equal(classifyComment("acknowledged"), "other"); // ACK must be the token, not a substring
  assert.equal(classifyComment("**Opus completion for Issue #57 (dedupe pr56:a709f55…:opus:revise:1)**"), "completion");
  assert.equal(classifyComment("<!-- gpt-pm-event-state:v1 pr56:abc:codex:review:1 -->\nPlease look"), "other");
});

test("links PRs by title refs, keyword body refs and issue-comment PR mentions only", () => {
  assert.deepEqual([...pullIssueRefs({ title: "PR56 revision (#57)", body: "see #3 and Refs #55, Closes: #9" }).body].sort(), [55, 9].sort());
  assert.deepEqual([...pullIssueRefs({ title: "PR56 revision (#57)", body: null }).title], [57]);
  assert.deepEqual([...commentPullRefs("- PR: #58, targeting x. also https://github.com/o/r/pull/56 and issue #7")].sort(), [56, 58]);
});

test("shows ACK without PR as implementing, missing ACK as awaiting ACK, no fabricated PRs", () => {
  const r = build([issue(1, ["agent:opus", "status:ready"]), issue(2, ["agent:opus", "status:in-progress"])], [], [comment(10, 2, "ACK — started", "2026-01-01T00:00:00Z")]);
  const [i2, i1] = r.issues;
  assert.equal(i1.nextAction.code, "await_ack");
  assert.equal(i2.nextAction.code, "agent_implementing");
  assert.equal(i2.acks.length, 1);
  assert.equal(i2.pulls.length, 0);
  assert.equal(r.runtimeProof, "not_included");
  assert.equal(r.source, "github");
});

test("review → revision → re-review → approval → owner decision from GitHub data", () => {
  const issues = [issue(5, ["agent:opus", "status:review"]), { ...issue(6, []), pull_request: {} }];
  const pulls = [pull(6, "feat: thing — Refs #5")];
  const reviews = [{ id: 1, state: "CHANGES_REQUESTED", submitted_at: "2026-01-01T02:00:00Z", user: { login: "codex[bot]" } }];
  let detail = new Map([[6, { reviews, commits: [commit("2026-01-01T01:00:00Z")], commitsTruncated: false }]]);
  let ev = build(issues, pulls, [], detail).issues[0];
  assert.equal(ev.pulls[0].linkedBy.join(), "title");
  assert.equal(ev.nextAction.code, "agent_revision");
  assert.equal(ev.pulls[0].revisions, 0);

  detail = new Map([[6, { reviews, commits: [commit("2026-01-01T01:00:00Z"), commit("2026-01-01T03:00:00Z")], commitsTruncated: false }]]);
  ev = build(issues, pulls, [], detail).issues[0];
  assert.equal(ev.nextAction.code, "pm_rereview");
  assert.equal(ev.pulls[0].revisions, 1);

  // PR #61 P1: a comment approval must name the exact current head SHA to count.
  const pmApprove = comment(20, 6, `Approved by PM\nhead ${"a".repeat(40)}`, "2026-01-01T04:00:00Z");
  ev = build(issues, pulls, [pmApprove], detail).issues[0];
  assert.equal(ev.nextAction.code, "owner_merge_decision");
  assert.equal(ev.pulls[0].decision?.source, "comment");
  assert.equal(ev.pulls[0].decision?.headMatch, "exact");
});

test("skipped detail is reported, not guessed; merged and closed issues map deterministically", () => {
  const ev = build([issue(5, ["agent:codex", "status:review"]), issue(4, ["agent:codex"], "closed")], [pull(6, "x", "Fixes #5", { merged_at: "2026-01-01T00:00:00Z", state: "closed" })], []);
  assert.equal(ev.issues[0].pulls[0].detail, "skipped");
  assert.equal(ev.issues[0].pulls[0].decision, undefined);
  assert.equal(ev.issues[0].nextAction.code, "pr_merged");
  assert.equal(ev.issues[1].nextAction.code, "closed_unverified"); // closed but no completion type → never "done" (I8)
  const ok = build([{ ...issue(4, ["agent:codex"], "closed", "Completion type: nondeploy"), state_reason: "completed" }], [], []);
  assert.equal(ok.issues[0].nextAction.code, "done");
  const cancelled = build([{ ...issue(4, ["agent:codex"], "closed", "Completion type: nondeploy"), state_reason: "not_planned" }], [], []);
  assert.equal(cancelled.issues[0].nextAction.code, "closed_unverified");
});

test("ambiguous labels require triage", () => {
  const ev = build([issue(1, ["agent:opus", "agent:codex", "status:ready"])], [], []);
  assert.equal(ev.issues[0].agent, "ambiguous");
  assert.equal(ev.issues[0].nextAction.code, "triage");
});

test("reader: unconfigured makes no request; GET-only, bounded, sanitized errors", async () => {
  let calls = 0;
  await assert.rejects(readGitHubEvidence({}, (async () => { calls++; return Response.json([]); }) as typeof fetch), EvidenceConfigurationError);
  assert.equal(calls, 0);

  const seen: string[] = [];
  const req = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const u = new URL(String(input));
    assert.equal(init?.method, "GET");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer t0k");
    seen.push(u.pathname);
    if (u.pathname.endsWith("/issues")) return Response.json([issue(5, ["agent:opus", "status:review"])]);
    if (u.pathname.endsWith("/pulls")) return Response.json([pull(6, "Refs #5"), pull(7, "unrelated")]);
    if (u.pathname.endsWith("/issues/comments")) return Response.json([]);
    if (u.pathname.endsWith("/pulls/6/reviews")) return Response.json([]);
    if (u.pathname.endsWith("/pulls/6/commits")) return Response.json([commit("2026-01-01T00:00:00Z")]);
    throw new Error(`unexpected ${u.pathname}`);
  }) as typeof fetch;
  const r = await readGitHubEvidence({ GITHUB_READ_TOKEN: "t0k", GITHUB_REPO: R }, req, () => new Date("2026-01-02T00:00:00Z"));
  assert.equal(r.issues[0].pulls[0].number, 6);
  assert.equal(r.issues[0].nextAction.code, "pm_review");
  assert.ok(!seen.some((p) => p.includes("/pulls/7/")), "unlinked PRs are not detailed");

  const fail = (async () => new Response("secret t0k", { status: 403 })) as typeof fetch;
  await assert.rejects(readGitHubEvidence({ GITHUB_TOKEN: "t0k", GITHUB_REPO: R }, fail), (e: unknown) => e instanceof EvidenceReadError && e.message === "github_http_403");
});

test("PM markers: review request on head → codex_review; bot review on head → pm_decision; followup revise addressed by head move", () => {
  const sha = "a".repeat(40), old = "c".repeat(40);
  const issues = [issue(5, ["agent:opus", "status:review"]), issue(9, ["agent:opus", "status:ready"])];
  const pulls = [pull(6, "feat — Refs #5")];
  const req = comment(30, 6, `<!-- gpt-pm-event-state:v1 pr6:${sha}:codex:review:1 -->\n@codex review`, "2026-01-01T05:00:00Z");
  const detail = new Map([[6, { reviews: [], commits: [commit("2026-01-01T01:00:00Z")], commitsTruncated: false }]]);
  assert.equal(build(issues, pulls, [req], detail).issues[1].nextAction.code, "codex_review");

  const botDetail = new Map([[6, { reviews: [{ id: 2, state: "COMMENTED", submitted_at: "2026-01-01T06:00:00Z", commit_id: sha, user: { login: "chatgpt-codex-connector[bot]", type: "Bot" } }], commits: [commit("2026-01-01T01:00:00Z")], commitsTruncated: false }]]);
  assert.equal(build(issues, pulls, [req], botDetail).issues[1].nextAction.code, "pm_decision");

  // follow-up marker on another issue (#9) names an older SHA of PR 6 → linked, and counted as addressed
  const follow = comment(31, 9, `<!-- gpt-pm-followup:pr6:${old}:claude-opus:revise:1 -->\nRevise`, "2026-01-01T07:00:00Z");
  const r = build(issues, pulls, [req, follow], botDetail);
  const i9 = r.issues[0];
  assert.equal(i9.pulls[0].number, 6);
  assert.equal(i9.pulls[0].decision?.source, "pm-marker");
  assert.equal(i9.pulls[0].decision?.headMoved, true);
  assert.equal(i9.pulls[0].revisions, 1);
  assert.equal(r.issues[1].nextAction.code, "pm_rereview");
});

test("revise addressed by a PR stacked on the head branch points PM at the stacked PR", () => {
  const sha = "a".repeat(40);
  const issues = [issue(5, ["agent:opus", "status:review"])];
  const pulls = [pull(6, "feat — Refs #5"), pull(8, "fix", null, { base: { ref: "feat" }, head: { ref: "fix", sha: "d".repeat(40) }, updated_at: "2026-01-01T09:00:00Z" })];
  const follow = comment(31, 5, `<!-- gpt-pm-followup:pr6:${sha}:claude-opus:revise:1 -->`, "2026-01-01T07:00:00Z");
  const detail = new Map([[6, { reviews: [], commits: [commit("2026-01-01T01:00:00Z")], commitsTruncated: false }]]);
  const ev = build(issues, pulls, [follow], detail).issues[0];
  assert.deepEqual(ev.pulls[0].decision?.stackedPulls, [8]);
  assert.equal(ev.pulls[0].revisions, 1);
  assert.equal(ev.nextAction.code, "pm_rereview");
  assert.match(ev.nextAction.label, /#8/);
});

test("PR #61 P1: official approval is bound to its commit_id, never to timestamps", () => {
  const head = "a".repeat(40), older = "e".repeat(40);
  const issues = [issue(5, ["agent:opus", "status:review"])];
  const pulls = [pull(6, "feat — Refs #5")];
  // Current head A was cherry-picked/rebased with a committer date OLDER than the review of SHA B.
  const commits = [commit("2026-01-01T01:00:00Z")];
  const review = (commit_id: string | null) => ({ id: 3, state: "APPROVED", submitted_at: "2026-01-01T05:00:00Z", commit_id, html_url: "https://x/r3", user: { login: "pm" } });

  let ev = build(issues, pulls, [], new Map([[6, { reviews: [review(older)], commits, commitsTruncated: false }]])).issues[0];
  assert.equal(ev.pulls[0].decision?.commitsAfter, 0, "timestamps alone would have looked fresh");
  assert.equal(ev.pulls[0].decision?.sha, older);
  assert.equal(ev.pulls[0].decision?.headMatch, "stale");
  assert.equal(ev.pulls[0].decision?.headMoved, true);
  assert.equal(ev.nextAction.code, "pm_rereview");
  assert.notEqual(ev.nextAction.code, "owner_merge_decision");

  ev = build(issues, pulls, [], new Map([[6, { reviews: [review(null)], commits, commitsTruncated: false }]])).issues[0];
  assert.equal(ev.pulls[0].decision?.headMatch, "unknown");
  assert.equal(ev.nextAction.code, "pm_decision");

  ev = build(issues, pulls, [], new Map([[6, { reviews: [review(head)], commits, commitsTruncated: false }]])).issues[0];
  assert.equal(ev.pulls[0].decision?.headMatch, "exact");
  assert.equal(ev.nextAction.code, "owner_merge_decision");

  // Comment approvals: no SHA or several SHAs → unknown; another single SHA → stale.
  const detail = new Map([[6, { reviews: [], commits, commitsTruncated: false }]]);
  for (const [body, match, code] of [
    ["Approved — LGTM", "unknown", "pm_decision"],
    [`Approved — base ${older} head ${head}`, "unknown", "pm_decision"],
    [`Approved at ${older}`, "stale", "pm_rereview"],
    [`승인 완료 ${head.toUpperCase()}`, "exact", "owner_merge_decision"],
  ] as const) {
    ev = build(issues, pulls, [comment(40, 6, body, "2026-01-01T05:00:00Z")], detail).issues[0];
    assert.equal(ev.pulls[0].decision?.headMatch, match, body);
    assert.equal(ev.nextAction.code, code, body);
  }
});

test("PR #61 P2: only affirmative approval counts; pending/required approval phrases do not", () => {
  for (const h of ["소유자 승인 필요", "## 승인 대기", "**소유자 승인 필요** — PR #61", "PM 승인 요청", "승인 전 검토 중", "병합 승인 필요",
    "Awaiting approval", "Pending owner approval", "Approval required before merge", "Needs approval", "Please approve", "Ready for approval",
    "Not yet approved", "미승인", "승인 불가", "승인 보류"]) {
    assert.notEqual(classifyComment(h), "approve", h);
  }
  for (const h of ["Approved — LGTM", "LGTM", "Verdict: APPROVE", "승인합니다", "PM 승인 완료", "✅ 승인", "승인됨 (head abc)", "승인 — 병합 가능"]) {
    assert.equal(classifyComment(h), "approve", h);
  }
  const issues = [issue(5, ["agent:opus", "status:review"])];
  const pulls = [pull(6, "feat — Refs #5")];
  const detail = new Map([[6, { reviews: [], commits: [commit("2026-01-01T01:00:00Z")], commitsTruncated: false }]]);
  for (const body of [`소유자 승인 필요\nhead ${"a".repeat(40)}`, `승인 대기 ${"a".repeat(40)}`]) {
    const ev = build(issues, pulls, [comment(41, 6, body, "2026-01-01T05:00:00Z")], detail).issues[0];
    assert.equal(ev.pulls[0].decision, undefined, body);
    assert.notEqual(ev.nextAction.code, "owner_merge_decision", body);
  }
});
