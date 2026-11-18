// Issue #182 — (A) fail-closed root fan-out (conservative superset / explicit BLOCKED) and (B) verified per-correction analysis clock.
// Both run through the REAL entrypoints (targetsFromEvent -> handleEvent -> refreshPr -> runCheck -> collectGateInput).
import test from "node:test";
import assert from "node:assert/strict";
import { runCheck } from "./check.mjs";
import { resolveCorrectionBoundary } from "./correction-boundary.mjs";
import { targetsFromEvent, handleEvent } from "./event-route.mjs";
import { createPrLock } from "./pr-lock.mjs";
import { ROOT_CEILING_EXCEPTIONS, ceilingFor, MAX_CORRECTIONS } from "../handoff/root-corrections.mjs";

const OWNER = { login: "jonghee1998", id: 129052128, type: "User" };
const MAL = { login: "mallory", id: 6, type: "User" };
const SRC = "a".repeat(40), NEW = "b".repeat(40), F1 = "1".repeat(40), F2 = "2".repeat(40);
const BR = "codex/issue-92-mobile-v2", AL = [BR];
const T = (h) => `2026-11-18T0${h}:00:00Z`;
const NOW = Date.parse(T(9));
const gate = (name, a, at = T(0)) => ({ user: OWNER, created_at: at, updated_at: at, body: `<!-- gate:${name}:v1 ${a} -->` });
const c = (id, o) => ({ id, created_at: T(1), updated_at: T(1), ...o });
const fc = (cls, pr, sha) => `<!-- gate:fail-class:v1 root=1 class=${cls} pr=${pr} sha=${sha} -->`;
const analysis = (at = T(1), upd = at) => ({ ...c(2, { user: OWNER, body: "<!-- gate:dev-analysis:v1 issue=1 -->" }), created_at: at, updated_at: upd });
const receipts = (a = analysis()) => [c(1, gate("pm-scope", "issue=1")), a, c(3, gate("self-test", `issue=1 sha=${NEW} typecheck=pass test=pass build=pass`))];
const cm = (sha, at) => ({ sha, commit: { committer: { date: at } } });
const FOLLOW = `<!-- gpt-pm-followup:pr4:${SRC}:claude:revise:2 -->`;

/** Fake API for a CORRECTION PR 5 superseding PR 4 (HEAD SRC at T0, inherited commits) with one NEW commit at T2. */
function fake(o = {}) {
  const w = { comments: receipts(), issueBody: `<!-- orch-root-request:v1 #1 -->\n${FOLLOW}`, prBody: "Closes #1\n<!-- orch-supersedes:v1 pr4 -->", prUser: OWNER, srcHead: SRC, srcTime: T(0),
    cmp: { status: "ahead", ahead_by: 1, behind_by: 0, total_commits: 1, merge_base_sha: SRC, commits: [cm(NEW, T(2))] }, cmpFail: false, root: [], ...o };
  const statuses = [];
  return {
    w, statuses,
    getPull: async (n) => n === 5 ? { number: 5, state: "open", user: w.prUser, head: { sha: NEW }, base: { ref: BR }, body: w.prBody, created_at: T(1), updated_at: T(1) } : { number: n, user: OWNER, head: { sha: w.srcHead } },
    getIssue: async () => ({ number: 1, user: OWNER, body: w.issueBody, created_at: T(0), updated_at: T(0) }),
    getCommit: async () => cm(SRC, w.srcTime),
    compareCommits: async () => { if (w.cmpFail) throw new Error("GitHub GET /compare -> 502"); return w.cmp; },
    listPullCommits: async () => [cm(SRC, T(0)), cm(NEW, T(2))], // INHERITED + new: min(all) would be T(0)
    listIssueComments: async (n) => (n === 1 ? w.comments : []),
    listIssues: async () => [], listPulls: async () => w.root,
    createCommitStatus: async (sha, s) => { statuses.push({ sha, ...s }); },
  };
}
const pre = (g) => runCheck({ gh: g, prNumber: 5, stage: "pre-pr", publish: true, now: NOW });

test("#182-B1 analysis between inherited and NEW code commit passes (old min(all) rejected it); boundary = first NEW commit", async () => {
  const g = fake(); const r = await pre(g);
  assert.equal(r.status, "pass", JSON.stringify(r.unmet)); assert.equal(g.statuses.at(-1).state, "success");
  const b = await resolveCorrectionBoundary({ gh: g, pr: await g.getPull(5), linkedIssue: await g.getIssue(1), commits: [], now: NOW });
  assert.deepEqual([b.boundary, b.firstCodeCommitAt, b.source, b.newCommits], ["correction", T(2).replace("Z", ".000Z"), { pr: 4, sha: SRC }, 1]);
});
test("#182-B2 analysis edited after / equal to / created after the new code commit is blocked; forged-early created_at cannot help", async () => {
  for (const [a, reason] of [[analysis(T(1), T(3)), "analysis_edited_after_code"], [analysis(T(1), T(2)), "analysis_edited_after_code"], [analysis(T(2), T(2)), "analysis_not_before_code"], [analysis(T(3), T(3)), "analysis_not_before_code"]]) {
    const r = await pre(fake({ comments: receipts(a) }));
    assert.equal(r.status, "blocked"); assert.ok(r.unmet.some((u) => u.includes(reason)), `${reason}:${JSON.stringify(r.unmet)}`);
  }
});
test("#182-B3 every boundary failure fails CLOSED with a failure status on the exact SHA (never pass, never min(all) fallback)", async () => {
  const bad = {
    no_new_commit: { cmp: { status: "identical", ahead_by: 0, behind_by: 0, total_commits: 0, merge_base_sha: SRC, commits: [] } },
    boundary_not_descendant_diverged: { cmp: { status: "diverged", ahead_by: 1, behind_by: 1, total_commits: 1, merge_base_sha: "c".repeat(40), commits: [cm(NEW, T(2))] } },
    boundary_not_descendant_behind: { cmp: { status: "behind", ahead_by: 0, behind_by: 2, total_commits: 0, merge_base_sha: NEW, commits: [] } },
    merge_base_mismatch: { cmp: { status: "ahead", ahead_by: 1, behind_by: 0, total_commits: 1, merge_base_sha: "c".repeat(40), commits: [cm(NEW, T(2))] } },
    enumeration_incomplete_count: { cmp: { status: "ahead", ahead_by: 300, behind_by: 0, total_commits: 300, merge_base_sha: SRC, commits: Array.from({ length: 250 }, () => cm(NEW, T(2))) } },
    enumeration_incomplete_tip: { cmp: { status: "ahead", ahead_by: 1, behind_by: 0, total_commits: 1, merge_base_sha: SRC, commits: [cm("d".repeat(40), T(2))] } },
    forged_future: { cmp: { status: "ahead", ahead_by: 1, behind_by: 0, total_commits: 1, merge_base_sha: SRC, commits: [cm(NEW, "2099-01-01T00:00:00Z")] } },
    forged_before_source: { srcTime: T(1), cmp: { status: "ahead", ahead_by: 1, behind_by: 0, total_commits: 1, merge_base_sha: SRC, commits: [cm(NEW, T(0))] } },
    commit_time_missing: { cmp: { status: "ahead", ahead_by: 1, behind_by: 0, total_commits: 1, merge_base_sha: SRC, commits: [{ sha: NEW, commit: {} }] } },
    compare_api_failure: { cmpFail: true },
    force_push_source_mismatch: { srcHead: "e".repeat(40) },
    source_unrecorded: { issueBody: "<!-- orch-root-request:v1 #1 -->" },
    source_sha_ambiguous: { issueBody: `<!-- orch-root-request:v1 #1 -->\n${FOLLOW}\n<!-- gpt-pm-followup:pr4:${"f".repeat(40)}:claude:revise:3 -->` },
    source_pr_conflict: { issueBody: `<!-- orch-root-request:v1 #1 -->\n<!-- gpt-pm-followup:pr3:${SRC}:claude:revise:2 -->` },
    supersedes_missing: { prBody: "Closes #1" },
    supersedes_ambiguous: { prBody: "Closes #1\n<!-- orch-supersedes:v1 pr4 -->\n<!-- orch-supersedes:v1 none -->" },
    attacker_authored_pr_body: { prUser: MAL },
  };
  for (const [name, o] of Object.entries(bad)) {
    const g = fake(o); const r = await pre(g);
    assert.equal(r.status, "blocked", name); assert.ok(r.unmet.some((u) => u.startsWith("boundary:")), `${name}:${JSON.stringify(r.unmet)}`);
    assert.deepEqual([g.statuses.at(-1).state, g.statuses.at(-1).sha], ["failure", NEW], name);
  }
  // an untrusted author's followup marker is ignored: PR body / marker alone never establishes the source
  const forged = fake({ issueBody: `<!-- orch-root-request:v1 #1 -->` }); forged.getIssue = async () => ({ number: 1, user: MAL, body: `<!-- orch-root-request:v1 #1 -->\n${FOLLOW}` });
  assert.equal((await pre(forged)).status, "blocked");
});
test("#182-B4 repeated-failure RCA uses the SAME correction boundary (valid between inherited and new commit; after new code blocked)", async () => {
  const fails = [c(10, { user: OWNER, body: fc("evidence-scope", 90, F1) }), c(11, { user: OWNER, body: fc("evidence-scope", 91, F2) })];
  const rca = (at, upd = at) => ({ ...c(12, { user: OWNER, body: "<!-- gate:rca:v1 issue=1 class=evidence-scope -->" }), created_at: at, updated_at: upd });
  assert.equal((await pre(fake({ comments: [...receipts(), ...fails, rca(T(1))] }))).status, "pass");
  for (const r of [rca(T(3)), rca(T(1), T(3)), rca(T(2))]) {
    const res = await pre(fake({ comments: [...receipts(), ...fails, r] }));
    assert.equal(res.status, "blocked"); assert.ok(res.unmet.some((u) => u.startsWith("rca:rca_not_before_code")), JSON.stringify(res.unmet));
  }
});
test("#182-B5 original PR (`supersedes none`) is handled separately: min over its OWN commits, complete enumeration required", async () => {
  const g = fake({ prBody: "Closes #1\n<!-- orch-supersedes:v1 none -->", comments: receipts(analysis(T(0), T(1))) });
  g.listPullCommits = async () => [cm(NEW, T(2))];
  assert.equal((await pre(g)).status, "pass");
  const big = fake({ prBody: "Closes #1\n<!-- orch-supersedes:v1 none -->" }); big.listPullCommits = async () => Array.from({ length: 250 }, () => cm(NEW, T(2)));
  assert.ok((await pre(big)).unmet.includes("boundary:commit_enumeration_incomplete"));
  const empty = fake({ prBody: "Closes #1\n<!-- orch-supersedes:v1 none -->" }); empty.listPullCommits = async () => [];
  assert.equal((await pre(empty)).status, "blocked");
});
test("#182-B6 root146 bound is 12 for that ordinal only; every other root keeps the default", () => {
  assert.deepEqual(ROOT_CEILING_EXCEPTIONS, { 146: 12 }); assert.equal(ceilingFor(146), 12);
  assert.equal(MAX_CORRECTIONS, 3); assert.equal(ceilingFor(147), 5); assert.equal(ceilingFor(1), 5);
});

// ---------- A. fan-out ----------
const iss = (number, root, extra = {}) => ({ number, user: OWNER, body: root ? `<!-- orch-root-request:v1 #${root} -->` : "plain", created_at: T(0), updated_at: T(0), ...extra });
const pr = (number, linked, o = {}) => ({ number, state: "open", user: OWNER, head: { sha: String(number % 10).repeat(40), repo: { full_name: "o/r" } }, base: { ref: BR, repo: { full_name: "o/r" } }, body: `Closes #${linked}`, created_at: T(2), updated_at: T(2), ...o });
function world(over = {}) {
  const issues = { 1: iss(1, 1), 2: iss(2, 1), 3: iss(3, 1), 50: iss(50, 50), ...over.issues };
  const pulls = over.pulls ?? [pr(5, 1), pr(6, 2), pr(7, 3), pr(8, 50)];
  return {
    getIssue: async (n) => { if (over.gone?.includes(n)) throw new Error(`GitHub GET /issues/${n} -> 404`); return issues[n] ?? { number: n, user: OWNER, body: "plain" }; },
    getPull: async (n) => pulls.find((p) => p.number === n) ?? pr(n, 1),
    listPulls: async () => { if (over.listPulls) return over.listPulls(); return pulls; },
  };
}
const ev = (name, number, isPr = false) => ({ name, payload: name === "pull_request_target" ? { pull_request: { number } } : { issue: { number, ...(isPr ? { pull_request: {} } : {}) } } });
const T4 = [5, 6, 7, 8];

test("#182-A1 ambiguous / edited / forged root marker => conservative SUPERSET (all eligible open PRs), never only the event PR", async () => {
  const amb = (o) => ({ issues: { 1: iss(1, 1, { body: "<!-- orch-root-request:v1 #1 -->\n<!-- orch-root-request:v1 #2 -->" }) }, ...o });
  for (const [n, isPr, name] of [[1, false, "issue_comment"], [1, false, "issues"], [2, false, "issue_comment"]]) {
    const r = await targetsFromEvent({ ...ev(name, n, isPr), gh: world(amb()), allowlist: AL });
    assert.deepEqual(r.targets, T4, `${name} #${n}`); assert.equal(r.superset, true); assert.match(r.error, /root_request_ambiguous/); assert.equal(r.blocked, undefined);
  }
  const notSelf = await targetsFromEvent({ ...ev("issues", 1), gh: world({ issues: { 1: iss(1, 9), 9: iss(9, 7) } }), allowlist: AL });
  assert.deepEqual(notSelf.targets, T4); assert.match(notSelf.error, /root_not_self_marked/);
});
test("#182-A2 deleted root/sibling issue (404) => superset; marker DELETED from the root => lineage-touching PRs refreshed, unrelated root untouched", async () => {
  assert.deepEqual((await targetsFromEvent({ ...ev("issues", 1), gh: world({ gone: [1] }), allowlist: AL })).targets, T4);
  const noMarker = await targetsFromEvent({ ...ev("issues", 1), gh: world({ issues: { 1: iss(1, 0) } }), allowlist: AL });
  assert.deepEqual(noMarker.targets, [5, 6, 7]); assert.equal(noMarker.skip, undefined);
  const del = await targetsFromEvent({ ...ev("issue_comment", 2), gh: world({ issues: { 2: iss(2, 0) } }), allowlist: AL });
  assert.deepEqual(del.targets, [6], "sibling issue lost its marker: its own PR is refreshed (fails closed itself)");
  assert.deepEqual((await targetsFromEvent({ ...ev("issue_comment", 99), gh: world(), allowlist: AL })).skip, "unrelated_no_root_marker");
});
test("#182-A3 PR marker retargeted/forged (marker root != linked root) or ambiguous => superset", async () => {
  const gh = (body) => world({ pulls: [pr(5, 1, { body }), pr(6, 2), pr(7, 3), pr(8, 50)] });
  const re = await targetsFromEvent({ ...ev("pull_request_target", 5), gh: gh("Closes #1\n<!-- orch-root-request:v1 #50 -->"), allowlist: AL });
  assert.deepEqual(re.targets, T4); assert.match(re.error, /root_marker_conflict/);
  const amb = await targetsFromEvent({ ...ev("pull_request_target", 5), gh: gh("Closes #1\n<!-- orch-root-request:v1 #1 -->\n<!-- orch-root-request:v1 #50 -->"), allowlist: AL });
  assert.deepEqual(amb.targets, T4);
});
test("#182-A4 un-enumerable conservative set => explicit BLOCKED with stale statement (never a silent skip / safety claim); event PR still targeted", async () => {
  for (const lp of [() => { throw new Error("pagination bound exceeded"); }, () => ({})]) {
    const r = await targetsFromEvent({ ...ev("issue_comment", 5, true), gh: world({ listPulls: lp }), allowlist: AL });
    assert.deepEqual([r.blocked, r.error, r.targets], [true, "pr_enumeration_failed", [5]]); assert.match(r.stale, /may remain stale/);
    const i = await targetsFromEvent({ ...ev("issue_comment", 1), gh: world({ listPulls: lp }), allowlist: AL });
    assert.deepEqual([i.blocked, i.targets], [true, []]);
  }
  const many = Array.from({ length: 300 }, (_, k) => pr(100 + k, 1));
  const r = await targetsFromEvent({ ...ev("issue_comment", 1), gh: world({ pulls: many }), allowlist: AL });
  assert.equal(r.targets.length, 256); assert.equal(r.blocked, true); assert.match(r.stale, /not refreshed: 356/);
});
test("#182-A5 forbidden scope kept: closed / fork / off-allowlist PRs never targeted even in the superset", async () => {
  const pulls = [pr(5, 1), pr(6, 1, { state: "closed" }), pr(7, 1, { head: { sha: "7".repeat(40), repo: { full_name: "fork/r" } } }), pr(8, 1, { base: { ref: "main", repo: { full_name: "o/r" } } })];
  const r = await targetsFromEvent({ ...ev("issues", 1), gh: world({ pulls, gone: [1] }), allowlist: AL });
  assert.deepEqual(r.targets, [5]);
});
test("#182-A6 router -> refreshPr -> REAL runCheck: ambiguous root marker leaves NO prior success on any affected SHA (pending then failure each)", async () => {
  const statuses = [];
  const base = world({ issues: { 1: iss(1, 1, { body: "<!-- orch-root-request:v1 #1 -->\n<!-- orch-root-request:v1 #2 -->" }) } });
  const gh = { ...base, listIssueComments: async () => [], listIssues: async () => [], listPullCommits: async () => [cm("5".repeat(40), T(2))], createCommitStatus: async (sha, s) => { statuses.push({ sha, state: s.state, context: s.context }); } };
  const out = await handleEvent({ name: "issue_comment", payload: { issue: { number: 1 } }, gh, allowlist: AL, lock: createPrLock() });
  assert.deepEqual(out.targets, T4); assert.ok(out.error);
  for (const p of T4) {
    const mine = statuses.filter((s) => s.sha === String(p % 10).repeat(40));
    for (const ctx of ["quality-gate/pre-pr", "quality-gate/final"]) {
      const seq = mine.filter((s) => s.context === ctx).map((s) => s.state);
      assert.equal(seq[0], "pending", `${p}/${ctx}`); assert.equal(seq.at(-1), "failure", `${p}/${ctx}`); assert.ok(!seq.includes("success"));
    }
  }
});
test("#182-A7 duplicate events / head race: same PR stays serialized through ONE lock; different PRs independent", async () => {
  const lock = createPrLock(); let active = 0, max = 0; const seen = [];
  const check = async ({ prNumber, stage }) => { active++; max = Math.max(max, active); seen.push(`${prNumber}:${stage}`); await new Promise((r) => setTimeout(r, 2)); active--; return { status: "blocked", head: "0".repeat(40), published: true, unmet: [] }; };
  await Promise.all([1, 2].map(() => handleEvent({ name: "workflow_dispatch", payload: { inputs: { pr: "5" } }, gh: world(), allowlist: AL, check, lock })));
  assert.equal(max, 1); assert.equal(seen.length, 4);
});

// ---------- C. related failure-as-empty / stale-success audit ----------
import { destinationProof } from "../handoff/root-corrections.mjs";
import { evaluateGate } from "./quality-gate.mjs";
test("#182-C1 unavailable compare / missing history / unreadable PR never default to a pass or an empty success", async () => {
  const rec = [{ pr: 5, sha: SRC, n: 12 }];
  assert.equal(destinationProof({ records: rec, pr: 5, liveSha: NEW, cmp: null }).ancestryOk, false, "compare failure (catch->null) is unproven");
  for (const failHistory of [undefined, null, "x"]) assert.notEqual(evaluateGate({ issue: 1, head: NEW, items: receipts(), failHistory, firstCodeCommitAt: T(2) }).status, "pass");
  assert.notEqual(evaluateGate({ issue: 1, head: NEW, items: receipts(), failHistory: [], firstCodeCommitAt: undefined }).status, "pass", "unknown boundary time never passes");
  // PR unreadable AND no payload SHA: nothing can be written => reported (published:false => CLI exit 1), not swallowed
  const gh = { ...world(), getPull: async () => { throw new Error("GitHub GET /pulls/5 -> 403"); }, createCommitStatus: async () => { throw new Error("must not write without a SHA"); } };
  const out = await handleEvent({ name: "workflow_dispatch", payload: { inputs: { pr: "5" } }, gh, allowlist: AL, lock: createPrLock() });
  assert.ok(out.results.length && out.results.every((r) => r.status === "blocked" && r.published === false && r.unmet.includes("pr_head_unknown")));
});
