// #57 (PR56 Codex review 5907446716): reproductions + regressions for the three findings.
//  P1 r4575905114: the writer fence is per (repository, workBranch) across ALL workflows/channels, not per workflow.
//  P2 r4575905117: the legacy HMAC /api/runs/callback can never touch a session-origin run (no heartbeat/activity).
//  P2 r4575905119: session self-reports are never presented as verified on the read APIs / UI models.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { assignCollaboration, claimCollaboration, decideCollaboration, finishCollaboration, quiesceCollaboration, type Assignment, type ExecutionResult } from "./collaboration";
import type { CollaborationGitHub, PullSnapshot } from "./collaboration-github";
import { MemoryRunStore, type RunStore } from "./store";
import { submitQueued, type DispatchAdapter } from "./dispatcher";
import { handleSession } from "./session-http";
import { applyCallback, reconcile } from "./service";
import { signCallback } from "./callback-auth";
import { handleRunCallback } from "./callback-http";
import { runTrust, runView, parseTrust, trustLabel } from "./run-trust";
import { buildSnapshot } from "../control/service";
import type { DispatchRecord } from "./run-tracking";

const NOW = "2026-01-01T00:00:00.000Z", MS = Date.parse(NOW), A = "a".repeat(40), B = "b".repeat(40);
const TOKEN = "opus-session-token-" + "x".repeat(40);
const ENV = { RUN_CALLBACK_SECRET_CLAUDE_OPUS: "opus-hmac-secret-value", RUN_CALLBACK_SECRET_CLAUDE_SONNET: "sonnet-hmac-secret-value",
  SESSION_TOKEN_SHA256_CLAUDE_OPUS: createHash("sha256").update(TOKEN).digest("hex"), CONTROL_ADMIN_TOKEN: "admin".repeat(5) };
const asg = (o: Partial<Assignment> = {}): Assignment => ({ repo: "o/r", issueNumber: 55, baseBranch: "claude/base", baseSha: A, sourcePr: 54,
  workBranch: "claude/issue-55", claudeAgent: "claude-opus", instructions: "Implement", reviewCompletedPr: false, ...o });
const runnerResult = (sha = B, pr = 60): ExecutionResult => ({ exitCode: 0, headSha: sha, summary: "done", tests: [{ command: "npm test", exitCode: 0 }], prNumber: pr, cleanup: { processGroupsEmpty: true, groups: 1 } });
const sessionResult = { exitCode: 0, headSha: B, summary: "Implemented", tests: [{ command: "npm test", exitCode: 0 }], prNumber: 60 };

async function env() {
  const store = new MemoryRunStore();
  await store.transact(d => { d.control.agents["claude-opus"] = true; d.control.agents["claude-sonnet"] = true; d.control.agents.codex = true; d.control.claudeProvider = true; });
  // Any repo: the base PR #54 is claude/base@A, the work PR #60 is on claude/issue-55@B.
  const github: CollaborationGitHub = { branch: async () => A, descendsFrom: async () => true,
    pull: async (repo, n) => n === 54
      ? { number: 54, repo, headBranch: "claude/base", headSha: A, baseBranch: "main", url: `https://github.com/${repo}/pull/54`, open: true }
      : { number: n, repo, headBranch: "claude/issue-55", headSha: B, baseBranch: "claude/base", url: `https://github.com/${repo}/pull/${n}`, open: true } as PullSnapshot };
  const adapter: DispatchAdapter = { supports: () => true, submit: async () => ({ outcome: "accepted" }) };
  const workflow = async (o: Partial<Assignment>) => {
    const w = await assignCollaboration(store, github, asg(o), NOW);
    await submitQueued(store, adapter, w.dispatchId!, NOW);
    return w;
  };
  let n = 0;
  const session = (body: object, eventId = `sess-${String(++n).padStart(6, "0")}`) =>
    handleSession(new Headers({ "x-agent-key": "claude-opus", "x-event-id": eventId, "x-timestamp": String(MS), "x-orch-session-token": TOKEN }),
      JSON.stringify(body), { store: () => store as RunStore, github, adapter, env: ENV, nowMs: MS }).then(r => ({ ...r, json: JSON.parse(r.body) }));
  const sessionClaim = (issueNumber: number, dispatchId: string, runId = `session-run-${issueNumber}`) =>
    session({ v: 1, action: "claim", agent: "claude-opus", issueNumber, dispatchId, runId, targetSha: A });
  return { store, github, adapter, workflow, session, sessionClaim };
}

// ---------------------------------------------------------------- P1: cross-workflow writer fence
test("P1: a second workflow on the same repo/workBranch cannot claim while a session writer is unquiesced", async () => {
  const s = await env();
  const w1 = await s.workflow({ issueNumber: 55 });
  const w2 = await s.workflow({ issueNumber: 56 }); // a different issue/workflow, same repository AND workBranch
  assert.equal((await s.sessionClaim(55, w1.dispatchId!)).status, 200);
  // runner (HMAC) channel on the second workflow
  await assert.rejects(claimCollaboration(s.store, w2.dispatchId!, "claude-opus", "runner-run-0056", NOW), /prior_execution_not_quiesced/);
  // session channel on the second workflow
  const c = await s.sessionClaim(56, w2.dispatchId!);
  assert.equal(c.status, 409); assert.equal(c.json.error, "prior_execution_not_quiesced");
  const rec = (await s.store.read()).records[w2.dispatchId!];
  assert.equal(rec.runId, undefined, "the refused claim left no runId behind"); assert.equal(rec.status, "dispatched");
});

test("P1: a session writer that FINISHED (self-report, no cleanup proof) still fences every other workflow on that branch", async () => {
  const s = await env();
  const w1 = await s.workflow({ issueNumber: 55 });
  const w2 = await s.workflow({ issueNumber: 56 });
  assert.equal((await s.sessionClaim(55, w1.dispatchId!)).status, 200);
  const f = await s.session({ v: 1, action: "finish", agent: "claude-opus", issueNumber: 55, dispatchId: w1.dispatchId, runId: "session-run-55", targetSha: A, result: sessionResult });
  assert.equal(f.status, 200); assert.equal((await s.store.read()).records[w1.dispatchId!].status, "succeeded");
  await assert.rejects(claimCollaboration(s.store, w2.dispatchId!, "claude-opus", "runner-run-0056", NOW), /prior_execution_not_quiesced/);
  assert.equal((await s.sessionClaim(56, w2.dispatchId!)).json.error, "prior_execution_not_quiesced");
});

test("P1: mixed origins — an unquiesced RUNNER writer fences a session claim on another workflow; cleanup proof releases it", async () => {
  const s = await env();
  const w1 = await s.workflow({ issueNumber: 55 });
  const w2 = await s.workflow({ issueNumber: 56 });
  await claimCollaboration(s.store, w1.dispatchId!, "claude-opus", "runner-run-0055", NOW);
  assert.equal((await s.sessionClaim(56, w2.dispatchId!)).json.error, "prior_execution_not_quiesced");
  // Still blocked after the record merely becomes terminal (timeout) — terminal is not cleanup.
  await reconcile(s.store, new Date(MS + 60 * 60_000).toISOString());
  assert.equal((await s.store.read()).records[w1.dispatchId!].status, "timeout");
  const w3 = await s.workflow({ issueNumber: 57 }); // fresh workflow after the timeout (w2 itself ACK-timed out)
  assert.equal((await s.sessionClaim(57, w3.dispatchId!)).json.error, "prior_execution_not_quiesced");
  // Only the runner's signed quiescence (actual cleanup) releases the branch.
  await quiesceCollaboration(s.store, w1.dispatchId!, "claude-opus", "runner-run-0055", { reason: "lease_expired", processGroupEmpty: true, signal: "SIGKILL" }, NOW);
  const c = await s.sessionClaim(57, w3.dispatchId!);
  assert.equal(c.status, 200, JSON.stringify(c.json)); assert.equal(c.json.record.runOrigin, "session");
});

test("P1: concurrent claims of two workflows on one branch — exactly one writer wins (atomic, any channel mix)", async () => {
  for (const mix of [["runner", "runner"], ["runner", "session"], ["session", "session"]] as const) {
    const s = await env();
    const w1 = await s.workflow({ issueNumber: 55 });
    const w2 = await s.workflow({ issueNumber: 56 });
    const claim = (kind: "runner" | "session", issue: number, id: string) => kind === "runner"
      ? claimCollaboration(s.store, id, "claude-opus", `runner-run-${issue}`, NOW).then(() => true, () => false)
      : s.sessionClaim(issue, id).then(r => r.status === 200);
    const won = await Promise.all([claim(mix[0], 55, w1.dispatchId!), claim(mix[1], 56, w2.dispatchId!)]);
    assert.equal(won.filter(Boolean).length, 1, `mix ${mix.join("+")}: ${won}`);
    const running = Object.values((await s.store.read()).records).filter(r => r.status === "running");
    assert.equal(running.length, 1);
  }
});

test("P1: PM revise of another workflow on the same branch is fenced; branch-name case variants share the fence", async () => {
  const s = await env();
  const w1 = await s.workflow({ issueNumber: 55 });
  const w2 = await s.workflow({ issueNumber: 56, workBranch: "Claude/Issue-55" });
  await claimCollaboration(s.store, w2.dispatchId!, "claude-opus", "runner-run-0056", NOW);
  await finishCollaboration(s.store, s.github, w2.dispatchId!, "claude-opus", "runner-run-0056", { ...runnerResult(), exitCode: 1 }, NOW);
  // w2 is blocked (execution_failed) with cleanup proof; w1 now claims as a session writer and stays unquiesced.
  assert.equal((await s.sessionClaim(55, w1.dispatchId!)).status, 200);
  await assert.rejects(decideCollaboration(s.store, s.github, w2.id, A, "revise", "retry", NOW), /prior_execution_not_quiesced/);
});

test("P1 controls: unrelated repository or branch is not fenced; codex (read-only) steps never fence", async () => {
  const s = await env();
  const w1 = await s.workflow({ issueNumber: 55 });
  const other = await s.workflow({ issueNumber: 57, workBranch: "claude/issue-57" });
  const otherRepo = await s.workflow({ repo: "o/other", issueNumber: 58 });
  assert.equal((await s.sessionClaim(55, w1.dispatchId!)).status, 200);
  assert.equal((await claimCollaboration(s.store, other.dispatchId!, "claude-opus", "runner-run-0057", NOW)).status, "running");
  assert.equal((await s.sessionClaim(58, otherRepo.dispatchId!)).status, 200);
  const review = await s.workflow({ issueNumber: 59, reviewCompletedPr: true });
  assert.equal((await claimCollaboration(s.store, review.dispatchId!, "codex", "codex-run-0059", NOW)).status, "running");
});

// ---------------------------------------------------------------- P2: legacy callback origin isolation
async function legacy(s: Awaited<ReturnType<typeof env>>, body: object, eventId: string, nowMs = MS, agent = "claude-opus") {
  const raw = JSON.stringify(body), ts = String(nowMs);
  const h = new Headers({ "x-agent": agent, "x-timestamp": ts, "x-event-id": eventId, "x-signature": signCallback(ENV[`RUN_CALLBACK_SECRET_${agent.toUpperCase().replace(/-/g, "_")}` as keyof typeof ENV], ts, eventId, raw) });
  const r = await handleRunCallback(h, raw, () => s.store, ENV, nowMs);
  return { ...r, json: JSON.parse(r.body) };
}

test("P2: a signed legacy heartbeat with the matching runId cannot touch a session run, and timeout is not suppressed", async () => {
  const s = await env();
  const w = await s.workflow({ issueNumber: 55 });
  assert.equal((await s.sessionClaim(55, w.dispatchId!)).status, 200);
  const before = (await s.store.read()).records[w.dispatchId!];
  const later = MS + 10 * 60_000;
  const r = await legacy(s, { dispatchId: w.dispatchId, runId: "session-run-55", type: "heartbeat" }, "legacy-hb-0001", later);
  assert.equal(r.status, 409); assert.equal(r.json.error, "origin_mismatch");
  const after = (await s.store.read());
  assert.equal(after.records[w.dispatchId!].lastHeartbeatAt, before.lastHeartbeatAt, "heartbeat untouched");
  assert.equal(after.records[w.dispatchId!].lastActivityAt, before.lastActivityAt, "activity untouched");
  assert.equal(after.events["legacy-hb-0001"], undefined, "rejected event is not consumed");
  // Direct service call too (every legacy event type), not only the HTTP wrapper.
  for (const type of ["heartbeat", "ack", "started", "finished"] as const) {
    const ev = type === "finished" ? { type, at: NOW, runId: "session-run-55", ok: true } : { type, at: NOW, runId: "session-run-55" };
    assert.deepEqual(await applyCallback(s.store, `legacy-${type}-01`, w.dispatchId!, "claude-opus", ev, NOW), { ok: false, reason: "origin_mismatch" });
  }
  // Without a real lease renewal, the session run still times out on schedule.
  await reconcile(s.store, new Date(MS + 16 * 60_000).toISOString());
  assert.equal((await s.store.read()).records[w.dispatchId!].status, "timeout");
});

test("P2: legacy runner compatibility — signed heartbeats still renew a runner-claimed collaboration run", async () => {
  const s = await env();
  const w = await s.workflow({ issueNumber: 55 });
  await claimCollaboration(s.store, w.dispatchId!, "claude-opus", "runner-run-0055", NOW);
  const t = MS + 10 * 60_000;
  const r = await legacy(s, { dispatchId: w.dispatchId, runId: "runner-run-0055", type: "heartbeat" }, "legacy-hb-0002", t);
  assert.equal(r.status, 200); assert.equal(r.json.duplicate, false);
  assert.equal((await s.store.read()).records[w.dispatchId!].lastHeartbeatAt, new Date(t).toISOString());
  assert.equal((await legacy(s, { dispatchId: w.dispatchId, runId: "runner-run-0055", type: "heartbeat" }, "legacy-hb-0002", t)).json.duplicate, true);
  // Security properties of the HMAC route are unchanged: bad signature / other agent's key / unknown dispatch.
  const raw = JSON.stringify({ dispatchId: w.dispatchId, runId: "runner-run-0055", type: "heartbeat" });
  const bad = await handleRunCallback(new Headers({ "x-agent": "claude-opus", "x-timestamp": String(t), "x-event-id": "legacy-hb-0003", "x-signature": "00" }), raw, () => s.store, ENV, t);
  assert.equal(bad.status, 401);
  assert.equal((await legacy(s, { dispatchId: w.dispatchId, runId: "runner-run-0055", type: "heartbeat" }, "legacy-hb-0004", t, "claude-sonnet")).status, 404, "agent mismatch");
  assert.equal((await legacy(s, { dispatchId: "nope", runId: "runner-run-0055", type: "heartbeat" }, "legacy-hb-0005", t)).status, 404);
  assert.equal((await handleRunCallback(new Headers({ "x-agent": "claude-opus" }), raw, () => s.store, {}, t)).status, 503, "missing secret fails closed");
});

// ---------------------------------------------------------------- P2: trust propagation to read APIs / UI models
test("P2 trust: session claim is not stored as an agent-callback, and the runs read API never marks it verified", async () => {
  const s = await env();
  const w = await s.workflow({ issueNumber: 55 });
  await s.sessionClaim(55, w.dispatchId!);
  let rec = (await s.store.read()).records[w.dispatchId!];
  assert.notEqual(rec.source, "agent-callback");
  let v = runView(rec);
  assert.equal(v.verified, false); assert.equal(v.origin, "session");
  assert.deepEqual(v.trust, { origin: "session", receipt: "session_header", execution: "none", cleanup: "unproven", verified: false });
  await s.session({ v: 1, action: "finish", agent: "claude-opus", issueNumber: 55, dispatchId: w.dispatchId, runId: "session-run-55", targetSha: A, result: sessionResult });
  rec = (await s.store.read()).records[w.dispatchId!];
  v = runView(rec);
  assert.equal(v.status, "succeeded"); assert.equal(v.verified, false);
  assert.equal(v.trust.execution, "session_self_report_unverified"); assert.equal(v.trust.cleanup, "unproven");
  const label = trustLabel(v.trust, v.status);
  assert.match(label.text, /자기보고/); assert.match(label.text, /미검증/); assert.match(label.text, /정리 증명 없음/);
  assert.equal(label.verified, false);
  assert.doesNotMatch(label.text, /agent 확인|검증됨/);
  // dashboard/control snapshot uses the same trust mapping
  const snap = buildSnapshot(await s.store.read(), NOW).runs.find(r => r.dispatchId === w.dispatchId)!;
  assert.equal(snap.verified, false); assert.equal(snap.trust.origin, "session");
});

test("P2 trust: session FAILURE, HMAC runner success, legacy records and malformed payloads", async () => {
  const s = await env();
  const w = await s.workflow({ issueNumber: 55 });
  await s.sessionClaim(55, w.dispatchId!);
  await s.session({ v: 1, action: "finish", agent: "claude-opus", issueNumber: 55, dispatchId: w.dispatchId, runId: "session-run-55", targetSha: A, result: { ...sessionResult, exitCode: 1 } });
  const failed = runView((await s.store.read()).records[w.dispatchId!]);
  assert.equal(failed.status, "failed"); assert.equal(failed.verified, false); assert.equal(failed.trust.execution, "session_self_report_unverified");
  assert.match(trustLabel(failed.trust, failed.status).text, /자기보고/);

  const r = await env();
  const rw = await r.workflow({ issueNumber: 55 });
  await claimCollaboration(r.store, rw.dispatchId!, "claude-opus", "runner-run-0055", NOW);
  await finishCollaboration(r.store, r.github, rw.dispatchId!, "claude-opus", "runner-run-0055", runnerResult(), NOW);
  const ok = runView((await r.store.read()).records[rw.dispatchId!]);
  assert.deepEqual(ok.trust, { origin: "runner", receipt: "hmac_signed", execution: "runner_reported", cleanup: "runner_attested", verified: true });
  assert.equal(ok.verified, true); assert.match(trustLabel(ok.trust, ok.status).text, /HMAC/);

  // Legacy records: pre-#55 HMAC callback (no runOrigin) stays verified; a PR56-era session record that was stored
  // with source "agent-callback" (no runOrigin field lost) is still derived as a session self-report.
  const legacyRec: DispatchRecord = { dispatchId: "d-1-claude-opus-1", issueNumber: 1, agent: "claude-opus", status: "running", requestedAt: NOW, attempt: 1, evidence: [], source: "agent-callback", runId: "r-00000001" };
  assert.deepEqual(runTrust(legacyRec), { origin: "runner", receipt: "hmac_signed", execution: "none", cleanup: "unproven", verified: true });
  const pr56Session = { ...legacyRec, runOrigin: "session" as const, execution: { exitCode: 0, summary: "x", headSha: B, tests: [], attestation: "external_session_self_report" as const } };
  assert.equal(runTrust(pr56Session).verified, false); assert.equal(runTrust(pr56Session).receipt, "session_header");
  // attestation without runOrigin (partial record) is still never verified
  const partial = { ...legacyRec, execution: pr56Session.execution };
  assert.equal(runTrust(partial).verified, false); assert.equal(runTrust(partial).execution, "session_self_report_unverified");
  const never: DispatchRecord = { ...legacyRec, source: "none", runId: undefined, status: "queued" };
  assert.deepEqual(runTrust(never), { origin: null, receipt: "none", execution: "none", cleanup: "not_applicable", verified: false });

  // Malformed/partial API payloads: never upgraded to verified.
  for (const bad of [undefined, null, 1, "x", {}, { verified: true }, { origin: "session", receipt: "hmac_signed", execution: "x", cleanup: "y", verified: true },
    { origin: "session", receipt: "session_header", execution: "none", cleanup: "unproven", verified: true }]) {
    const t = parseTrust(bad);
    if (t) assert.equal(t.verified, false, JSON.stringify(bad));
    const l = trustLabel(t, "running");
    assert.equal(l.verified, false, JSON.stringify(bad));
  }
  assert.match(trustLabel(null, "running").text, /근거 미상/);
  assert.match(trustLabel(null, "unknown").text, /수신 미확인/);
});
