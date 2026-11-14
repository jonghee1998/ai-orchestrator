// #53 integration contract: the progress view-model must accept the REAL response shapes produced by the
// backend stack (PR44/48/50/52: blocked stages, cleanup proof, quiescence, cleanup_failed). Synthetic in-memory
// store flows only — no provider, no network.
import assert from "node:assert/strict";
import test from "node:test";
import { assignCollaboration, claimCollaboration, finishCollaboration, decideCollaboration, quiesceCollaboration, reportCleanupFailure, type Assignment, type ExecutionResult } from "../../lib/runs/collaboration";
import type { CollaborationGitHub, PullSnapshot } from "../../lib/runs/collaboration-github";
import { handleCollaboration } from "../../lib/runs/collaboration-http";
import { MemoryRunStore, type RunStore } from "../../lib/runs/store";
import { submitQueued, type DispatchAdapter } from "../../lib/runs/dispatcher";
import { displayStatus, latencies } from "../../lib/runs/run-tracking";
import { buildCards, parseRuns, parseWorkflows } from "./viewModel";

const NOW = "2026-01-01T00:00:00.000Z", MS = Date.parse(NOW), A = "a".repeat(40), B = "b".repeat(40);
const assignment: Assignment = { repo: "o/r", issueNumber: 36, baseBranch: "claude/base", baseSha: A, sourcePr: 35, workBranch: "claude/issue-36", claudeAgent: "claude-sonnet", instructions: "x", reviewCompletedPr: true };
const pr: PullSnapshot = { number: 35, repo: "o/r", headBranch: "claude/base", headSha: A, baseBranch: "main", url: "https://github.com/o/r/pull/35", open: true };
const result: ExecutionResult = { exitCode: 0, summary: "findings", headSha: A, tests: [{ command: "npm test", exitCode: 0 }], prNumber: 35, cleanup: { processGroupsEmpty: true, groups: 3 } };
const github: CollaborationGitHub = { branch: async () => A, pull: async () => structuredClone(pr), descendsFrom: async () => true };
const adapter: DispatchAdapter = { supports: (a) => a !== "gpt", submit: async () => ({ outcome: "accepted" }) };
const env = { CONTROL_ADMIN_TOKEN: "admin".repeat(5), CONTROL_READ_TOKEN: "reader".repeat(5), GITHUB_REPO: "o/r" };

// Mirrors src/app/api/runs/route.ts exactly (route imports next/server, so it is not in the test build).
async function apiRuns(store: RunStore): Promise<unknown> {
  const { records } = await store.read();
  const runs = Object.values(records).map((r) => ({
    dispatchId: r.dispatchId, issueNumber: r.issueNumber, agent: r.agent, attempt: r.attempt,
    status: displayStatus(r), verified: r.source === "agent-callback", submission: r.submission ?? null,
    lastActivityAt: r.lastActivityAt ?? r.lastHeartbeatAt ?? r.dispatchedAt ?? r.requestedAt,
    lastError: r.lastError ?? null, evidence: r.evidence, latency: latencies(r),
    collaboration: r.collaboration ?? null, execution: r.execution ?? null,
  }));
  return JSON.parse(JSON.stringify({ mode: "live", runs }));
}
async function apiWorkflows(store: RunStore): Promise<unknown> {
  const r = await handleCollaboration("GET", new Headers({ "x-admin-token": env.CONTROL_READ_TOKEN }), "", { store: () => store, github, adapter, env, nowMs: MS });
  assert.equal(r.status, 200);
  return JSON.parse(r.body);
}
async function setup() {
  const store = new MemoryRunStore();
  await store.transact((d) => { d.control.agents.codex = true; d.control.agents["claude-sonnet"] = true; d.control.claudeProvider = true; });
  const w = await assignCollaboration(store, github, assignment, NOW);
  await submitQueued(store, adapter, w.dispatchId!, NOW);
  await claimCollaboration(store, w.dispatchId!, "codex", "run-00001", NOW);
  return { store, id: w.dispatchId!, wid: w.id };
}
async function parsed(store: RunStore) {
  const runs = parseRuns(200, await apiRuns(store)), wfs = parseWorkflows(200, await apiWorkflows(store));
  assert.ok(Array.isArray(runs), "parseRuns rejected a real /api/runs body"); assert.ok(Array.isArray(wfs), "parseWorkflows rejected a real /api/collaboration body");
  return buildCards(runs, wfs);
}

test("#53 contract: finish with cleanup proof -> PM stage parses; branch/SHA/next action coherent", async () => {
  const s = await setup();
  await finishCollaboration(s.store, github, s.id, "codex", "run-00001", result, NOW);
  const [c] = await parsed(s.store);
  assert.equal(c.bucket, "completed"); assert.equal(c.sha, A); assert.equal(c.shaKind, "head");
  assert.equal(c.branch, "claude/base"); assert.match(c.nextAction, /PM 검수/); assert.match(c.findings!, /1\/1/);
});
test("#53 contract: quiesced (lease_revoked) and cleanup_failed records parse as blocked, never running", async () => {
  for (const kind of ["quiesce", "cleanup_failed"] as const) {
    const s = await setup();
    if (kind === "quiesce") await quiesceCollaboration(s.store, s.id, "codex", "run-00001", { reason: "lease_revoked", processGroupEmpty: true, signal: "SIGKILL" }, NOW);
    else await reportCleanupFailure(s.store, s.id, "codex", "run-00001", { reason: "normal_exit", groups: 2, unproven: 1 }, NOW);
    const wfs = parseWorkflows(200, await apiWorkflows(s.store)) as { stage: string }[];
    assert.equal(wfs[0].stage, "blocked", kind);
    const [c] = await parsed(s.store);
    assert.equal(c.bucket, "blocked", kind); assert.match(c.nextAction, /차단됨/, kind);
    // No execution was stored: SHA is the dispatch target (not a reported head); branch is the PR head bound to that target SHA.
    assert.equal(c.shaKind, "target", kind); assert.equal(c.sha, A, kind); assert.equal(c.branch, "claude/base", kind); assert.equal(c.findings, null, kind);
  }
});
test("#53 contract: PM revise -> cycle 2; historical cycle-1 card does not inherit cycle-2 workflow", async () => {
  const s = await setup();
  await finishCollaboration(s.store, github, s.id, "codex", "run-00001", result, NOW);
  await decideCollaboration(s.store, github, s.wid, A, "revise", "fix", NOW);
  const cards = await parsed(s.store);
  assert.equal(cards.length, 2);
  const old = cards.find((c) => c.dispatchId === s.id)!, cur = cards.find((c) => c.dispatchId !== s.id)!;
  assert.equal(old.branch, null); assert.match(old.nextAction, /결과 검수/);
  assert.match(cur.task, /cycle 2/); assert.equal(cur.bucket, "queued"); assert.notEqual(cur.sha, B);
});
