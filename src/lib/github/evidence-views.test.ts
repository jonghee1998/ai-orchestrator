// Issue #65 — GitHub evidence projections for /progress, /agents, /activity and #64→PR63 linkage.
import assert from "node:assert/strict";
import test from "node:test";
import { buildEvidence, commentPullRefs, type RawComment, type RawIssue, type RawPull } from "./evidence";
import { absence, atLeast, evidenceCoverage, githubActivity, githubAgents, githubProgress, parseEvidenceResponse, stageOf } from "./evidence-views";
import { readGitHubEvidence } from "./evidence-reader";

const R = "o/r", SHA = "05b409b0ca4fa36f4c9400104aec916f1d991f2f";
const issue = (n: number, labels: string[], state = "open", body: string | null = null, title = `Issue ${n}`): RawIssue =>
  ({ number: n, title, body, html_url: `https://github.com/${R}/issues/${n}`, state, labels });
const comment = (id: number, thread: number, body: string, at: string, login = "owner"): RawComment =>
  ({ id, body, html_url: `https://github.com/${R}/issues/${thread}#c${id}`, issue_url: `https://api.github.com/repos/${R}/issues/${thread}`, created_at: at, user: { login, type: login.endsWith("[bot]") ? "Bot" : "User" } });
const pull = (n: number, title: string, body: string | null = null, extra: Partial<RawPull> = {}): RawPull =>
  ({ number: n, title, body, html_url: `https://github.com/${R}/pull/${n}`, state: "open", head: { ref: "claude/x", sha: SHA }, base: { ref: "claude/base" }, updated_at: "2026-01-01T00:00:00Z", ...extra });
const build = (issues: RawIssue[], pulls: RawPull[], comments: RawComment[], detail = new Map()) =>
  buildEvidence({ repo: R, generatedAt: "2026-01-02T00:00:00Z", issues, pulls, comments, pullDetail: detail, commentsTruncated: false, pullsTruncated: false });

test("#65: #64-style issue body links its PR only by explicit reference (/pull/N URL or PR63)", () => {
  const body = "Exact reviewed branch claude/x@" + SHA + ", Codex no findings https://github.com/o/r/pull/63#issuecomment-1. Report via new PR63 comment.";
  const r = build([issue(64, ["agent:opus", "status:review"], "open", body, "Final production release — verified PR63"), issue(65, ["agent:opus", "status:ready"], "open", "same branch claude/x and SHA " + SHA)],
    [pull(63, "PR61 revision (#62)", "Refs #62")], [comment(1, 64, "ACK — Opus 시작", "2026-01-01T01:00:00Z")]);
  const i64 = r.issues.find((i) => i.number === 64)!, i65 = r.issues.find((i) => i.number === 65)!;
  assert.deepEqual(i64.pulls.map((p) => [p.number, p.linkedBy.join("+")]), [[63, "issue-body"]]);
  // Same branch/SHA text but no explicit PR reference -> no guessed link.
  assert.equal(i65.pulls.length, 0);
  assert.notEqual(i64.nextAction.code, "await_pr");
});
test("#65: compact PR refs are upper-case only; markers inside HTML comments are not prose refs", () => {
  assert.deepEqual([...commentPullRefs("see PR63 and pr64 and PR #7")].sort((a, b) => a - b), [7, 63]);
  assert.deepEqual([...commentPullRefs("<!-- PR99 --> nothing")], []);
});

test("#65: progress counts come from GitHub state; label-only done is NOT completion; no false zero", () => {
  const r = build([
    issue(1, ["agent:opus", "status:done"]),          // label says done but issue is open
    issue(2, ["agent:codex", "status:ready"]),         // no ACK
    issue(3, ["agent:claude", "status:in-progress"]),  // ACKed
    { ...issue(4, ["agent:opus", "status:done"], "closed", "Completion type: nondeploy"), state_reason: "completed" }, // closed, completed, explicit type
    issue(5, ["agent:opus", "status:done"], "closed"), // closed without a completion type: NOT done (I8)
  ], [], [comment(10, 3, "ACK — started", "2026-01-01T00:00:00Z")]);
  const g = githubProgress(r);
  assert.equal(g.total, 5); assert.equal(g.open, 3);
  assert.equal(g.stages.done, 1, "only the closed issue with proven completion counts as done"); assert.equal(g.stages.closed_unverified, 1);
  assert.equal(g.stages.await_ack, 1); assert.ok(g.stages.implementing >= 1);
  const row1 = g.rows.find((x) => x.number === 1)!;
  assert.notEqual(row1.stage, "done"); assert.equal(row1.statusLabel, "done");
  assert.equal(g.rows.find((x) => x.number === 3)!.ack?.url, "https://github.com/o/r/issues/3#c10");
  assert.equal(g.rows.find((x) => x.number === 2)!.ack, null);
});

test("#65: review / next action reflect SHA-bound decision; agents grouped by label with real ACK times", () => {
  const issues = [issue(5, ["agent:opus", "status:review"]), issue(6, ["agent:codex", "status:ready"])];
  const reviews = [{ id: 1, state: "APPROVED", submitted_at: "2026-01-01T02:00:00Z", commit_id: SHA, user: { login: "pm" } }];
  const r = build(issues, [pull(7, "feat — Refs #5")], [comment(11, 5, "ACK — Opus", "2026-01-01T00:30:00Z"), comment(12, 5, "**Completion report (Opus)**", "2026-01-01T01:30:00Z")],
    new Map([[7, { reviews, commits: [{ sha: SHA, commit: { committer: { date: "2026-01-01T01:00:00Z" } } }], commitsTruncated: false }]]));
  const row = githubProgress(r).rows.find((x) => x.number === 5)!;
  assert.equal(row.stage, "owner_decision"); assert.match(row.pull!.review, /현재 head 일치/);
  assert.equal(row.completion?.at, "2026-01-01T01:30:00Z");
  const agents = githubAgents(r);
  const opus = agents.find((a) => a.label === "opus")!, codex = agents.find((a) => a.label === "codex")!;
  assert.equal(opus.agentKey, "claude-opus"); assert.equal(opus.acked, 1); assert.equal(opus.lastAck?.at, "2026-01-01T00:30:00Z"); assert.equal(opus.openPulls, 1);
  assert.equal(codex.agentKey, "codex"); assert.equal(codex.unacked, 1); assert.equal(codex.lastAck, null);
  const ev = githubActivity(r);
  assert.deepEqual(ev.map((e) => e.kind), ["approve", "completion", "ack"]);
  assert.equal(ev[0].pull, 7);
});

test("#65: stage mapping covers every next-action code; parse rejects non-live bodies", () => {
  for (const code of ["done", "blocked", "await_ack", "agent_implementing", "await_pr", "pm_review", "agent_revision", "pm_rereview", "owner_merge_decision", "pr_merged", "triage", "codex_review", "pm_decision"] as const)
    assert.ok(stageOf({ nextAction: { code, label: "", actor: "" } }));
  assert.equal(parseEvidenceResponse(200, { mode: "unconfigured" }), "unconfigured");
  assert.equal(parseEvidenceResponse(502, { mode: "error", error: "x" }), null);
  assert.equal(parseEvidenceResponse(200, { mode: "live", report: { source: "runtime", issues: [] } }), null);
});

test("#67: open issue whose PR merged stays in the open list (PR merged but completion unverified)", () => {
  const r = build([issue(8, ["agent:opus", "status:review"]), issue(9, ["agent:opus", "status:done"], "closed")],
    [pull(10, "fix — Refs #8", null, { state: "closed", merged_at: "2026-01-01T03:00:00Z" } as Partial<RawPull>)], []);
  const g = githubProgress(r);
  const row = g.rows.find((x) => x.number === 8)!;
  assert.equal(r.issues.find((i) => i.number === 8)!.nextAction.code, "completion_unverified");
  assert.equal(row.stage, "review"); assert.equal(row.issueState, "open");
  const openList = g.rows.filter((x) => x.issueState === "open");
  assert.deepEqual(openList.map((x) => x.number), [8], "panel list uses issue state, so the pending closure is visible");
  assert.equal(g.open, openList.length, "summary open count matches the listed rows");
  assert.equal(g.rows.find((x) => x.number === 9)!.issueState, "closed");
});

test("#67: truncation is disclosed and qualifies counts / absence claims", () => {
  const full = build([issue(1, ["agent:opus", "status:ready"])], [], []);
  assert.deepEqual(evidenceCoverage(full), { issuesTruncated: false, pullsTruncated: false, commentsTruncated: false, partial: false, notes: [] });
  assert.equal(absence("ACK 코멘트", false), "ACK 코멘트 없음"); assert.equal(atLeast(3, false), "3");
  const cut = buildEvidence({ repo: R, generatedAt: "2026-01-02T00:00:00Z", issues: [issue(1, ["agent:opus", "status:ready"])], pulls: [], comments: [], pullDetail: new Map(), commentsTruncated: true, pullsTruncated: true, issuesTruncated: true });
  const c = evidenceCoverage(cut);
  assert.ok(c.partial && c.issuesTruncated && c.pullsTruncated && c.commentsTruncated); assert.equal(c.notes.length, 3);
  assert.match(absence("ACK 코멘트", true), /조회 범위 내/); assert.equal(atLeast(3, true), "≥3");
  // Legacy reports without issuesTruncated are treated as not truncated (never undefined → truthy).
  assert.equal(evidenceCoverage({ limits: { ...full.limits, issuesTruncated: undefined as unknown as boolean } }).issuesTruncated, false);
});

test("#67: reader reports issue truncation separately from PR truncation", async () => {
  const page = (n: number, base: number) => Array.from({ length: n }, (_, k) => issue(base + k, ["agent:opus", "status:ready"]));
  const req = (async (u: unknown) => {
    const url = new URL(String(u)); const p = Number(url.searchParams.get("page") ?? "1");
    if (url.pathname.endsWith("/issues")) return Response.json(page(100, p * 1000));
    return Response.json([]);
  }) as typeof fetch;
  const r = await readGitHubEvidence({ GITHUB_READ_TOKEN: "t", GITHUB_REPO: R }, req, () => new Date("2026-01-02T00:00:00Z"));
  assert.equal(r.limits.issuesTruncated, true); assert.equal(r.limits.pullsTruncated, false); assert.equal(r.limits.commentsTruncated, false);
  assert.equal(r.limits.issues, 300);
});

test("#69: Korean event summaries are deterministic; SHAs shortened, original preserved", async () => {
  const { summarizeEvent, shortenShas } = await import("./evidence-views");
  const e = { at: "2026-01-01T00:00:00Z", kind: "approve" as const, login: "pm", bot: false, issue: 5, pull: 7, text: `PR #7 리뷰 APPROVED @ ${SHA.slice(0, 7)}` };
  assert.equal(summarizeEvent(e), `pm이(가) PR #7을(를) 승인 (커밋 ${SHA.slice(0, 7)})`);
  assert.equal(summarizeEvent({ ...e, kind: "ack", pull: undefined, bot: true }), "pm (bot)이(가) 이슈 #5에 작업 시작(ACK)을 남김");
  assert.equal(shortenShas(`head ${SHA} ok`), `head ${SHA.slice(0, 7)} ok`);
  assert.equal(summarizeEvent(e), summarizeEvent(e));
});

test("#69: task split keeps open+merged-PR as remaining/closure-pending; closed is history; label alone is not completion", async () => {
  const { githubTaskSplit } = await import("./evidence-views");
  const r = build([issue(8, ["agent:opus", "status:done"]), issue(9, ["agent:opus", "status:done"], "closed"), issue(10, ["agent:claude", "status:ready"])],
    [pull(11, "fix — Refs #8", null, { state: "closed", merged_at: "2026-01-01T03:00:00Z" } as Partial<RawPull>)], []);
  const s = githubTaskSplit(r);
  assert.deepEqual(s.remaining.map((x) => x.number).sort(), [10, 8]);
  assert.deepEqual(s.history.map((x) => x.number), [9]);
  const t8 = s.remaining.find((x) => x.number === 8)!;
  // #113: no completion type → completion unknown → closure is NOT pending-provable (fail closed); the merged PR is still shown.
  assert.equal(t8.closurePending, false); assert.equal(t8.mergedPr, 11); assert.equal(t8.statusLabel, "done");
  assert.equal(s.remaining.find((x) => x.number === 10)!.closurePending, false);
});

test("#71: approval indicator is bound to the primary PR, not any historical PR (exact SHA)", async () => {
  const { githubTaskSplit } = await import("./evidence-views");
  const SHA2 = "1111111111111111111111111111111111111111";
  const commits = (sha: string) => [{ sha, commit: { committer: { date: "2026-01-01T01:00:00Z" } } }];
  const approved = (sha: string) => [{ id: 1, state: "APPROVED", submitted_at: "2026-01-01T02:00:00Z", commit_id: sha, user: { login: "pm" } }];
  const changes = [{ id: 2, state: "CHANGES_REQUESTED", submitted_at: "2026-01-01T02:00:00Z", commit_id: SHA2, user: { login: "pm" } }];
  const mk = (newer: Array<{ id: number; state: string; submitted_at: string; commit_id: string; user: { login: string } }>) => build(
    [issue(20, ["agent:claude", "status:review"])],
    [pull(21, "old — Refs #20", null, { state: "closed" }), pull(22, "new — Refs #20", null, { head: { ref: "claude/y", sha: SHA2 } })],
    [], new Map([
      [21, { reviews: approved(SHA), commits: commits(SHA), commitsTruncated: false }],
      [22, { reviews: newer, commits: commits(SHA2), commitsTruncated: false }],
    ]));
  // Older approved PR + newer open PR unreviewed -> no approval indicator.
  assert.equal(githubTaskSplit(mk([])).remaining[0].reviewedExact, false);
  // Newer open PR with changes requested -> no approval indicator.
  assert.equal(githubTaskSplit(mk(changes)).remaining[0].reviewedExact, false);
  // Newer open PR approved on its exact head -> indicator on.
  assert.equal(githubTaskSplit(mk(approved(SHA2))).remaining[0].reviewedExact, true);
  // Newer open PR approved on a stale SHA -> off.
  assert.equal(githubTaskSplit(mk(approved(SHA))).remaining[0].reviewedExact, false);
});

// ---- Issue #113: PM self-report vs official review rendered distinctly; stranded closed boundary; SHA case ----
import { acceptanceKind } from "./evidence-views";
test("T1r1/P2: PM self-report, official review and both are rendered as distinct signals; rollup counts PM-only", () => {
  const sha = "a".repeat(40);
  const mkPull = (o = {}) => ({ number: 10, url: "u", title: "", state: "merged", draft: false, base: "b", head: "h", headSha: sha, linkedBy: ["body"], commits: { count: 1, truncated: false }, reviews: [], comments: [], revisions: 0, detail: "loaded", ...o }) as never;
  const acc = [{ issue: 1, pr: 10, sha: sha.toUpperCase(), target: "b", at: "", url: "", by: "o" }];
  const off = { by: "r", at: "", sha: sha.toUpperCase(), url: "" };
  assert.equal(acceptanceKind(mkPull(), acc), "pm-self-report");
  assert.equal(acceptanceKind(mkPull({ officialApproval: off })), "official");
  assert.equal(acceptanceKind(mkPull({ officialApproval: off }), acc), "official+pm-self-report");
  assert.equal(acceptanceKind(mkPull(), []), "none");
  const rep = (pulls: unknown[], acceptances: unknown[]) => githubProgress({ source: "github", repo: "o/r", generatedAt: "", limits: {}, issues: [{ number: 1, title: "", url: "", agent: "claude", status: "review", state: "open", acks: [], completions: [], pulls, acceptances, nextAction: { code: "pm_review", label: "", actor: "" } }] } as never);
  const pm = rep([mkPull()], acc), off2 = rep([mkPull({ officialApproval: off })], acc);
  assert.match(pm.rows[0].pull!.review, /PM 자체 수락 표식.*공식 리뷰 아님/); assert.equal(pm.pmSelfReportOnly, 1);
  assert.match(off2.rows[0].pull!.review, /공식 리뷰 승인.*PM 자체 수락 표식/); assert.equal(off2.pmSelfReportOnly, 0);
  assert.equal(stageOf({ nextAction: { code: "completion_unverified", label: "", actor: "" } }), "review");
});
