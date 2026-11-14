import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assignCollaboration, claimCollaboration, finishCollaboration, decideCollaboration, refreshCollaboration, leaseCollaboration, quiesceCollaboration, type Assignment, type ExecutionResult } from "./collaboration";
import { GitHubEvidenceReader, type CollaborationGitHub, type PullSnapshot } from "./collaboration-github";
import { MemoryRunStore, FileRunStore } from "./store";
import { submitQueued, type DispatchAdapter } from "./dispatcher";
import { handleCollaboration, handleCollaborationWorker } from "./collaboration-http";
import { signCallback } from "./callback-auth";
import { applyCallback } from "./service";
const NOW = "2026-01-01T00:00:00.000Z", MS = Date.parse(NOW), A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40);
const assignment: Assignment = { repo: "o/r", issueNumber: 36, baseBranch: "claude/base", baseSha: A, sourcePr: 35, workBranch: "claude/issue-36", claudeAgent: "claude-sonnet", instructions: "Implement the PM task", reviewCompletedPr: true };
const original: PullSnapshot = { number: 35, repo: "o/r", headBranch: assignment.baseBranch, headSha: A, baseBranch: "main", url: "https://github.com/o/r/pull/35", open: true };
const result = (sha = A, pr = 35): ExecutionResult => ({ exitCode: 0, summary: "Actual review findings", headSha: sha, tests: [{ command: "npm test", exitCode: 0 }], prNumber: pr });
async function setup() {
  const store = new MemoryRunStore();
  await store.transact(d => { d.control.agents.codex = true; d.control.agents["claude-sonnet"] = true; d.control.claudeProvider = true; });
  const pulls = new Map<number, PullSnapshot>([[35, original]]);
  const github: CollaborationGitHub = { branch: async () => A, pull: async (_repo, n) => structuredClone(pulls.get(n)!), descendsFrom: async () => true };
  const calls: string[] = [];
  const adapter: DispatchAdapter = { supports: a => a !== "gpt", submit: async r => { calls.push(r.dispatchId); return { outcome: "accepted" }; } };
  const w = await assignCollaboration(store, github, assignment, NOW);
  const claim = async (id: string, agent: string, run = "run-00001") => { await submitQueued(store, adapter, id, NOW); return claimCollaboration(store, id, agent, run, NOW); };
  return { store, pulls, github, calls, adapter, w, claim };
}
test("PM assignment verifies exact branch and completed PR SHA before creating durable work", async () => {
  const s = await setup();
  assert.equal(s.w.stage, "codex");
  const rec = (await s.store.read()).records[s.w.dispatchId!];
  assert.equal(rec.collaboration?.baseSha, A); assert.equal(rec.collaboration?.targetSha, A);
  await assert.rejects(assignCollaboration(new MemoryRunStore(), s.github, { ...assignment, baseSha: B }, NOW), /baseline_mismatch/);
  await assert.rejects(assignCollaboration(s.store, s.github, assignment, NOW), /assignment_exists/);
  await assert.rejects(assignCollaboration(s.store, s.github, { ...assignment, workBranch: "main" }, NOW), /invalid_assignment/);
});
test("parallel submission and parallel claims execute a step once", async () => {
  const s = await setup(), id = s.w.dispatchId!;
  const send = await Promise.all(Array.from({ length: 8 }, () => submitQueued(s.store, s.adapter, id, NOW)));
  assert.equal(send.filter(r => r.ok).length, 1); assert.equal(s.calls.length, 1);
  const claims = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => claimCollaboration(s.store, id, "codex", `run-0000${i}`, NOW)));
  assert.equal(claims.filter(r => r.status === "fulfilled").length, 1);
});
test("OFF holds queued steps, blocks claims, never reroutes assigned actor", async () => {
  const s = await setup(), id = s.w.dispatchId!;
  await s.store.transact(d => { d.control.agents.codex = false; d.control.allowReroute = true; });
  assert.equal((await submitQueued(s.store, s.adapter, id, NOW)).ok, false);
  assert.equal(s.calls.length, 0); assert.equal(Object.keys((await s.store.read()).records).length, 1);
  await assert.rejects(claimCollaboration(s.store, id, "codex", "run-00001", NOW));
  await s.store.transact(d => { d.control.agents.codex = true; });
  await submitQueued(s.store, s.adapter, id, NOW);
  await s.store.transact(d => { d.control.agents.codex = false; });
  await assert.rejects(claimCollaboration(s.store, id, "codex", "run-00001", NOW), /agent_disabled/);
});
test("Claude completion -> Codex -> GPT PM -> Claude revision -> Codex -> PM approval, no merge", async () => {
  const s = await setup(); await s.claim(s.w.dispatchId!, "codex");
  let w = await finishCollaboration(s.store, s.github, s.w.dispatchId!, "codex", "run-00001", result(), NOW);
  assert.equal(w.stage, "pm");
  w = await decideCollaboration(s.store, s.github, w.id, A, "revise", "Fix the review findings", NOW);
  assert.equal(w.stage, "claude"); assert.equal(w.cycle, 2);
  await s.claim(w.dispatchId!, "claude-sonnet");
  const pr: PullSnapshot = { ...original, number: 38, headBranch: assignment.workBranch, headSha: B, baseBranch: assignment.baseBranch, url: "https://github.com/o/r/pull/38" };
  s.pulls.set(38, pr);
  w = await finishCollaboration(s.store, s.github, w.dispatchId!, "claude-sonnet", "run-00001", result(B, 38), NOW);
  assert.equal(w.stage, "codex");
  const reviewId = w.dispatchId!;
  await s.claim(reviewId, "codex");
  w = await finishCollaboration(s.store, s.github, reviewId, "codex", "run-00001", result(B, 38), NOW);
  assert.equal(w.stage, "pm");
  w = await decideCollaboration(s.store, s.github, w.id, B, "approve", "Reviewed and accepted", NOW);
  assert.equal(w.stage, "approved"); assert.equal(s.calls.length, 3);
  const rec = (await s.store.read()).records[reviewId];
  assert.equal(rec.execution?.tests[0].exitCode, 0); assert.equal(rec.execution?.headSha, B);
  await assert.rejects(decideCollaboration(s.store, s.github, w.id, B, "revise", "duplicate", NOW), /not_awaiting_pm/);
});
test("new PR HEAD before PM judgment invalidates review and queues the new SHA", async () => {
  const s = await setup(); await s.claim(s.w.dispatchId!, "codex");
  let w = await finishCollaboration(s.store, s.github, s.w.dispatchId!, "codex", "run-00001", result(), NOW);
  // Subsequent work PR is now the review target.
  const p = { ...original, number: 38, headBranch: assignment.workBranch, baseBranch: assignment.baseBranch, headSha: B };
  await s.store.transact(d => { d.collaborations![w.id].latest = p; });
  s.pulls.set(38, { ...p, headSha: C });
  w = await decideCollaboration(s.store, s.github, w.id, B, "approve", "old judgment", NOW);
  assert.equal(w.stage, "codex"); assert.equal(w.latest?.headSha, C);
  assert.equal((await s.store.read()).records[w.dispatchId!].collaboration?.targetSha, C);
});
test("stale/wrong-repository/wrong-base PR and wrong run results cannot advance", async () => {
  const s = await setup(); await s.claim(s.w.dispatchId!, "codex");
  await assert.rejects(finishCollaboration(s.store, s.github, s.w.dispatchId!, "codex", "other-run", result(), NOW), /run_mismatch/);
  s.pulls.set(35, { ...original, headSha: B });
  await assert.rejects(finishCollaboration(s.store, s.github, s.w.dispatchId!, "codex", "run-00001", result(B), NOW), /stale_or_unrelated_pr/);
  s.pulls.set(35, { ...original, repo: "evil/fork" });
  await assert.rejects(finishCollaboration(s.store, s.github, s.w.dispatchId!, "codex", "run-00001", result(), NOW), /stale_or_unrelated_pr/);
  assert.equal((await s.store.read()).collaborations![s.w.id].stage, "codex");
});
test("a PR with unrelated history cannot replace the PM baseline", async () => {
  const s = await setup(); await s.claim(s.w.dispatchId!, "codex");
  s.github.descendsFrom = async () => false;
  await assert.rejects(finishCollaboration(s.store, s.github, s.w.dispatchId!, "codex", "run-00001", result(), NOW), /baseline_not_ancestor/);
});
test("failed tests or zero tests are recorded as blocked, never successful execution", async () => {
  for (const tests of [[], [{ command: "npm test", exitCode: 1 }]]) {
    const s = await setup(); await s.claim(s.w.dispatchId!, "codex");
    const w = await finishCollaboration(s.store, s.github, s.w.dispatchId!, "codex", "run-00001", { ...result(), tests }, NOW);
    assert.equal(w.stage, "blocked"); assert.equal((await s.store.read()).records[s.w.dispatchId!].status, "failed");
    await assert.rejects(decideCollaboration(s.store, s.github, w.id, A, "approve", "ignore failures", NOW), /not_awaiting_pm/);
    const revision = await decideCollaboration(s.store, s.github, w.id, A, "revise", "Fix failed tests", NOW);
    assert.equal(revision.stage, "claude"); assert.equal(revision.cycle, 2);
  }
});
test("refresh supersedes an active stale review once, and refuses its late completion", async () => {
  const s = await setup();
  const p = { ...original, number: 38, headBranch: assignment.workBranch, baseBranch: assignment.baseBranch, headSha: B };
  await s.store.transact(d => {
    const w = d.collaborations![s.w.id]; w.latest = p;
    d.records[w.dispatchId!].collaboration!.targetSha = B;
    d.records[w.dispatchId!].collaboration!.prNumber = 38;
  });
  await s.claim(s.w.dispatchId!, "codex");
  s.pulls.set(38, { ...p, headSha: C });
  const rs = await Promise.allSettled([refreshCollaboration(s.store, s.github, s.w.id, NOW), refreshCollaboration(s.store, s.github, s.w.id, NOW)]);
  assert.ok(rs.some(r => r.status === "fulfilled"));
  const w = (await s.store.read()).collaborations![s.w.id];
  assert.equal(w.cycle, 2); assert.equal(w.latest?.headSha, C);
  assert.equal(Object.keys((await s.store.read()).records).length, 2);
  await refreshCollaboration(s.store, s.github, s.w.id, NOW);
  assert.equal(Object.keys((await s.store.read()).records).length, 2);
  await assert.rejects(finishCollaboration(s.store, s.github, s.w.dispatchId!, "codex", "run-00001", result(B, 38), NOW), /stale_or_unrelated_pr/);
});
test("duplicate completion is a no-op; legacy callback cannot bypass structured completion or claim", async () => {
  const s = await setup(); await s.claim(s.w.dispatchId!, "codex");
  await finishCollaboration(s.store, s.github, s.w.dispatchId!, "codex", "run-00001", result(), NOW);
  await finishCollaboration(s.store, s.github, s.w.dispatchId!, "codex", "run-00001", result(), NOW);
  assert.equal(Object.keys((await s.store.read()).records).length, 1);
  const r = await applyCallback(s.store, "bypass-001", s.w.dispatchId!, "codex", { type: "finished", at: NOW, runId: "run-00001", ok: true }, NOW);
  assert.deepEqual(r, { ok: false, reason: "collaboration_callback_required" });
});
test("lost label ACK is not resubmitted, but one signed worker can claim the authorized dispatch", async () => {
  const s = await setup();
  let count = 0;
  const unknown: DispatchAdapter = { supports: () => true, submit: async () => { count++; return { outcome: "unknown" }; } };
  await submitQueued(s.store, unknown, s.w.dispatchId!, NOW);
  await submitQueued(s.store, unknown, s.w.dispatchId!, NOW);
  assert.equal(count, 1);
  assert.equal((await claimCollaboration(s.store, s.w.dispatchId!, "codex", "run-00001", NOW)).status, "running");
});
test("file snapshot preserves workflow/results; fresh store instances serialize requests", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "collab-"));
  try {
    const file = path.join(dir, "state.json"), s = await setup();
    await fs.writeFile(file, JSON.stringify(await s.store.read()));
    await Promise.all(Array.from({ length: 10 }, () => new FileRunStore(file).transact(d => { d.blocked.test = (d.blocked.test ?? 0) + 1; })));
    const fresh = await new FileRunStore(file).read();
    assert.equal(fresh.blocked.test, 10); assert.equal(fresh.collaborations![s.w.id].assignment.baseSha, A);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test("HTTP: read/admin auth, per-agent signed identity, issue binding, replay and signed claim response", async () => {
  const s = await setup(); await submitQueued(s.store, s.adapter, s.w.dispatchId!, NOW);
  const env = { CONTROL_ADMIN_TOKEN: "admin".repeat(5), CONTROL_READ_TOKEN: "reader".repeat(5), RUN_CALLBACK_SECRET_CODEX: "codex-secret", RUN_CALLBACK_SECRET_CLAUDE_SONNET: "claude-secret", GITHUB_REPO: "o/r" };
  const d = { ...s, store: () => s.store, env, nowMs: MS };
  assert.equal((await handleCollaboration("GET", new Headers(), "", d)).status, 401);
  assert.equal((await handleCollaboration("POST", new Headers({ "x-admin-token": env.CONTROL_READ_TOKEN }), "{}", d)).status, 401);
  const body = { v: 2, agent: "codex", action: "claim", issueNumber: 36, dispatchId: s.w.dispatchId!, runId: "run-00001" };
  const request = (b: object, secret = "codex-secret", eventId = "worker-0001") => {
    const raw = JSON.stringify(b), h = new Headers({ "x-agent-key": "codex", "x-timestamp": String(MS), "x-event-id": eventId, "x-signature": signCallback(secret, String(MS), eventId, raw) });
    return handleCollaborationWorker(h, raw, d);
  };
  assert.equal((await request(body, "claude-secret")).status, 401);
  assert.equal((await request({ ...body, issueNumber: 37 })).status, 409);
  assert.equal((await request({ ...body, agent: "claude-sonnet" })).status, 400);
  const r = await request(body); assert.equal(r.status, 200); assert.ok(r.signature);
  assert.equal(JSON.parse(r.body).record.collaboration.targetSha, A);
  assert.equal((await request(body)).status, 409);
});
test("GitHub evidence reader rejects forks, does not trust arbitrary URLs, fails closed on HTTP failures", async () => {
  const payload = { number: 35, head: { sha: A, ref: "claude/base", repo: { full_name: "o/r" } }, base: { ref: "main", repo: { full_name: "o/r" } }, html_url: "https://evil.invalid", state: "open" };
  const urls: string[] = [];
  const reader = new GitHubEvidenceReader("o/r", "secret", (async (u: string) => { urls.push(u); return Response.json(payload); }) as typeof fetch);
  assert.equal((await reader.pull("o/r", 35)).url, "https://github.com/o/r/pull/35");
  assert.equal(urls[0], "https://api.github.com/repos/o/r/pulls/35");
  payload.head.repo.full_name = "evil/fork";
  await assert.rejects(reader.pull("o/r", 35), /invalid_pr_evidence/);
  await assert.rejects(reader.pull("other/repo", 35), /github_unconfigured/);
  const denied = new GitHubEvidenceReader("o/r", "secret", (async () => new Response("secret", { status: 403 })) as typeof fetch);
  await assert.rejects(denied.pull("o/r", 35), /github_evidence_unavailable/);
  const compare = new GitHubEvidenceReader("o/r", "secret", (async () => Response.json({ status: "ahead", merge_base_commit: { sha: A } })) as typeof fetch);
  assert.equal(await compare.descendsFrom("o/r", A, B), true);
  assert.equal(await compare.descendsFrom("o/r", C, B), false);
});
// #41 / PR #38 P2 regressions: recovery after submission rejection/timeout, and claim before label ACK.
test("P2: rejected label submission blocks the workflow; PM revise recovers it without resubmitting the old step", async () => {
  const s = await setup(), old = s.w.dispatchId!;
  const reject: DispatchAdapter = { supports: () => true, submit: async () => ({ outcome: "rejected_not_accepted", error: "http 422" }) };
  assert.equal((await submitQueued(s.store, reject, old, NOW)).ok, false);
  let d = await s.store.read();
  assert.equal(d.records[old].status, "failed");
  assert.equal(d.collaborations![s.w.id].stage, "blocked");
  assert.equal(d.collaborations![s.w.id].blockedReason, "not_executed");
  await assert.rejects(claimCollaboration(s.store, old, "codex", "run-00001", NOW), /not_claimable/);
  const w = await decideCollaboration(s.store, s.github, s.w.id, A, "revise", "Retry after fixing label permissions", NOW);
  assert.equal(w.stage, "claude"); assert.equal(w.cycle, 2); assert.notEqual(w.dispatchId, old); assert.equal(w.blockedReason, undefined);
  d = await s.store.read();
  assert.equal(d.records[old].status, "failed"); // the old step is never re-run
  await assert.rejects(decideCollaboration(s.store, s.github, s.w.id, A, "revise", "again", NOW), /not_awaiting_pm/);
});
test("P2: reconcile timeout of an unknown execution blocks; PM must explicitly acknowledge before recovery", async () => {
  const s = await setup(), id = s.w.dispatchId!;
  const unknown: DispatchAdapter = { supports: () => true, submit: async () => ({ outcome: "unknown" }) };
  await submitQueued(s.store, unknown, id, NOW);
  const { reconcile } = await import("./service");
  const later = new Date(MS + 6 * 60_000).toISOString();
  assert.equal(await reconcile(s.store, later), 1);
  let d = await s.store.read();
  assert.equal(d.records[id].status, "timeout");
  assert.equal(d.collaborations![s.w.id].stage, "blocked");
  assert.equal(d.collaborations![s.w.id].blockedReason, "execution_unknown");
  await assert.rejects(decideCollaboration(s.store, s.github, s.w.id, A, "revise", "retry", later), /unknown_execution_requires_ack/);
  await assert.rejects(decideCollaboration(s.store, s.github, s.w.id, A, "approve", "ok", later), /not_awaiting_pm/);
  // A late claim/finish of the timed-out step cannot advance the workflow.
  await assert.rejects(claimCollaboration(s.store, id, "codex", "run-00001", later), /not_claimable/);
  const w = await decideCollaboration(s.store, s.github, s.w.id, A, "revise", "Checked: no worker ran", later, true);
  assert.equal(w.stage, "claude");
  d = await s.store.read();
  assert.equal(d.records[id].status, "timeout");
});
test("P2: heartbeat timeout of a claimed run is unknown execution; late finish is refused after recovery", async () => {
  const s = await setup(), id = s.w.dispatchId!;
  await s.claim(id, "codex");
  const { reconcile } = await import("./service");
  const later = new Date(MS + 16 * 60_000).toISOString();
  await reconcile(s.store, later);
  assert.equal((await s.store.read()).collaborations![s.w.id].blockedReason, "execution_unknown");
  // #41 P1: acknowledgement alone no longer recovers a claimed run; the runner must prove quiescence first.
  await assert.rejects(decideCollaboration(s.store, s.github, s.w.id, A, "revise", "Recover", later, true), /prior_execution_not_quiesced/);
  await quiesceCollaboration(s.store, id, "codex", "run-00001", { reason: "lease_revoked", processGroupEmpty: true, signal: "SIGTERM" }, later);
  await decideCollaboration(s.store, s.github, s.w.id, A, "revise", "Recover", later, true);
  await assert.rejects(finishCollaboration(s.store, s.github, id, "codex", "run-00001", result(), later), /already_finished|stale_step/);
  assert.equal((await s.store.read()).collaborations![s.w.id].stage, "claude");
});
test("P2: legacy stuck workflow (terminal step, stage not blocked) is still recoverable by PM", async () => {
  const s = await setup(), id = s.w.dispatchId!;
  await s.store.transact(d => { d.records[id] = { ...d.records[id], status: "failed", submission: "rejected_not_accepted", finishedAt: NOW }; });
  const w = await decideCollaboration(s.store, s.github, s.w.id, A, "revise", "Recover legacy", NOW);
  assert.equal(w.stage, "claude");
});
test("P2: worker claim before label ACK is atomic; late adapter results never re-run or fail the claimed step", async () => {
  for (const late of ["accepted", "unknown", "rejected_not_accepted"] as const) {
    const s = await setup(), id = s.w.dispatchId!;
    let release!: () => void; let calls = 0;
    const slow: DispatchAdapter = { supports: () => true, submit: async () => { calls++; await new Promise<void>(r => { release = r; }); return { outcome: late }; } };
    const pending = submitQueued(s.store, slow, id, NOW);
    await new Promise(r => setImmediate(r));
    assert.equal((await s.store.read()).records[id].status, "queued");
    // Concurrent duplicate workers: exactly one claim wins while the ACK is still outstanding.
    const claims = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => claimCollaboration(s.store, id, "codex", `run-0000${i}`, NOW)));
    const won = claims.filter(c => c.status === "fulfilled") as PromiseFulfilledResult<{ runId?: string; status: string }>[];
    assert.equal(won.length, 1); assert.equal(won[0].value.status, "running");
    // Resubmission is refused while pending.
    assert.equal((await submitQueued(s.store, slow, id, NOW)).ok, false);
    release(); await pending;
    const r = (await s.store.read()).records[id];
    assert.equal(r.status, "running"); assert.equal(r.runId, won[0].value.runId); assert.equal(r.submission, late); assert.equal(calls, 1);
    const w = await finishCollaboration(s.store, s.github, id, "codex", won[0].value.runId!, result(), NOW);
    assert.equal(w.stage, "pm");
  }
});
test("P2: claim before ACK still honours OFF gate, held state, stale step and unauthorized queue", async () => {
  const s = await setup(), id = s.w.dispatchId!;
  await assert.rejects(claimCollaboration(s.store, id, "codex", "run-00001", NOW), /not_claimable/); // not yet authorized
  let release!: () => void;
  const slow: DispatchAdapter = { supports: () => true, submit: async () => { await new Promise<void>(r => { release = r; }); return { outcome: "accepted" }; } };
  const pending = submitQueued(s.store, slow, id, NOW);
  await new Promise(r => setImmediate(r));
  await s.store.transact(d => { d.control.agents.codex = false; });
  await assert.rejects(claimCollaboration(s.store, id, "codex", "run-00001", NOW), /agent_disabled/);
  await s.store.transact(d => { d.control.agents.codex = true; d.collaborations![s.w.id].dispatchId = "w-other"; });
  await assert.rejects(claimCollaboration(s.store, id, "codex", "run-00001", NOW), /stale_step/);
  release(); await pending;
});

// #41 P1 (r4575357529): a timed-out worker whose CLI keeps running must be fenced, not merely acknowledged.
type Runner = { leaseController: Function; superviseChild: Function; groupAlive: (pid: number) => boolean };
const loadRunner = () => (new Function("p", "return import(p)") as (p: string) => Promise<Runner>)(
  require("node:url").pathToFileURL(path.resolve("scripts/subscription-worker.mjs")).href);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function claudeStep(s: Awaited<ReturnType<typeof setup>>, run: string) {
  await s.claim(s.w.dispatchId!, "codex");
  await finishCollaboration(s.store, s.github, s.w.dispatchId!, "codex", "run-00001", result(), NOW);
  const w = await decideCollaboration(s.store, s.github, s.w.id, A, "revise", "Develop the fix", NOW);
  await s.claim(w.dispatchId!, "claude-sonnet", run);
  return w.dispatchId!;
}
test("P1: old still-running writer after heartbeat timeout blocks recovery until fenced; it never writes after the new claim", async () => {
  const runner = await loadRunner();
  const s = await setup(), old = await claudeStep(s, "old-run-01");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "p1-")), branch = path.join(root, "workBranch-writes");
  let clock = MS, connected = true;
  const iso = () => new Date(clock).toISOString();
  // The real server lease is the old worker's only control channel. Connectivity is lost mid-run (the P1 case).
  const lease = runner.leaseController(async () => { if (!connected) throw new Error("network partition"); return (await leaseCollaboration(s.store, old, "claude-sonnet", "old-run-01", iso())).lease; }, { intervalMs: 25, selfFenceMs: 60 * 60_000 });
  const supervised = runner.superviseChild(process.execPath, [path.resolve("scripts/fixtures/stubborn-writer.cjs"), branch], root, process.env, lease, { graceMs: 100 });
  try {
  await sleep(150);
  assert.equal((await s.store.read()).records[old].status, "running");
  connected = false;
  clock += 16 * 60_000;
  const { reconcile } = await import("./service");
  assert.equal(await reconcile(s.store, iso()), 1);
  let d = await s.store.read();
  assert.equal(d.records[old].status, "timeout"); assert.equal(d.collaborations![s.w.id].blockedReason, "execution_unknown");
  // The old CLI is still writing to the branch: acknowledgement must not let a second writer start.
  const before = (await fs.stat(branch)).size; await sleep(80);
  assert.ok((await fs.stat(branch)).size > before, "old worker keeps writing after timeout");
  await assert.rejects(decideCollaboration(s.store, s.github, s.w.id, A, "revise", "Recover", iso(), true), /prior_execution_not_quiesced/);
  // Every other path into a new writer is fenced at claim time too (e.g. refresh -> review -> PM revise).
  await s.store.transact(dd => {
    const w = dd.collaborations![s.w.id], id = `w-${w.id}-99-claude`;
    dd.records[id] = { ...dd.records[old], dispatchId: id, status: "dispatched", submission: "accepted", runId: undefined, finishedAt: undefined, quiescence: undefined,
      collaboration: { ...dd.records[old].collaboration!, cycle: 99 } };
    w.stage = "claude"; w.dispatchId = id;
  });
  const bypass = `w-${s.w.id}-99-claude`;
  await assert.rejects(claimCollaboration(s.store, bypass, "claude-sonnet", "new-run-01", iso()), /prior_execution_not_quiesced/);
  await s.store.transact(dd => { delete dd.records[bypass]; const w = dd.collaborations![s.w.id]; w.stage = "blocked"; w.dispatchId = old; });
  await assert.rejects(quiesceCollaboration(s.store, old, "claude-sonnet", "other-run-1", { reason: "lease_revoked", processGroupEmpty: true, signal: null }, iso()), /run_mismatch/);
  // Connectivity returns: the server revokes the lease, the runner kills the whole group and proves it empty.
  connected = true;
  const r = await supervised; lease.stop();
  assert.equal(r.fenced.reason, "lease_revoked"); assert.equal(r.fenced.processGroupEmpty, true);
  const pids: number[] = JSON.parse(await fs.readFile(branch + ".pids", "utf8"));
  assert.ok(pids.every(p => { try { process.kill(p, 0); return false; } catch { return true; } }));
  await quiesceCollaboration(s.store, old, "claude-sonnet", "old-run-01", { reason: r.fenced.reason, processGroupEmpty: true, signal: r.fenced.signal }, iso());
  const w = await decideCollaboration(s.store, s.github, s.w.id, A, "revise", "Recover after verified quiescence", iso(), true);
  const claimed = await s.claim(w.dispatchId!, "claude-sonnet", "new-run-01");
  assert.equal(claimed.status, "running");
  const atClaim = (await fs.stat(branch)).size; await sleep(150);
  assert.equal((await fs.stat(branch)).size, atClaim, "old worker wrote after the new writer claimed workBranch");
  d = await s.store.read();
  assert.equal(d.records[old].quiescence?.runId, "old-run-01"); assert.equal(d.records[old].status, "timeout");
  await assert.rejects(finishCollaboration(s.store, s.github, old, "claude-sonnet", "old-run-01", result(), iso()), /already_finished|stale_step/);
  } finally {
    // Never leak the stubborn writer if an assertion fails before the fence fires.
    lease.stop();
    const pids: number[] = await fs.readFile(branch + ".pids", "utf8").then(JSON.parse, () => []);
    if (pids[0]) { try { process.kill(-pids[0], "SIGKILL"); } catch { /* already stopped */ } }
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("P1: a self-fenced runner ends its still-running record as blocked/unknown, never as progress", async () => {
  const s = await setup(), old = await claudeStep(s, "old-run-02");
  assert.equal((await leaseCollaboration(s.store, old, "claude-sonnet", "old-run-02", NOW)).lease, "held");
  assert.equal((await leaseCollaboration(s.store, old, "claude-sonnet", "intruder-1", NOW)).lease, "revoked");
  await assert.rejects(quiesceCollaboration(s.store, old, "claude-sonnet", "old-run-02", { reason: "lease_expired", processGroupEmpty: false as unknown as true, signal: null }, NOW), /invalid_quiescence/);
  await quiesceCollaboration(s.store, old, "claude-sonnet", "old-run-02", { reason: "lease_expired", processGroupEmpty: true, signal: "SIGKILL" }, NOW);
  const d = await s.store.read();
  assert.equal(d.records[old].status, "failed"); assert.equal(d.collaborations![s.w.id].stage, "blocked");
  assert.equal(d.collaborations![s.w.id].blockedReason, "execution_unknown");
  assert.equal((await leaseCollaboration(s.store, old, "claude-sonnet", "old-run-02", NOW)).lease, "revoked");
  await assert.rejects(decideCollaboration(s.store, s.github, s.w.id, A, "revise", "no ack", NOW), /unknown_execution_requires_ack/);
  assert.equal((await decideCollaboration(s.store, s.github, s.w.id, A, "revise", "ack", NOW, true)).stage, "claude");
});
