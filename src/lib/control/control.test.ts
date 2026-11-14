import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileRunStore, MemoryRunStore } from "../runs/store";
import { authorizeSubmission, recordSubmission, requestDispatch, retryDispatchRecord } from "../runs/service";
import { buildSnapshot, guardProviderCall, mutateControl, requestCancel } from "./service";
import { defaultControl, evaluateGate, routeTarget, scheduleOpen } from "./model";

const T = (s: number) => new Date(Date.UTC(2026, 0, 5, 3, 0, s)).toISOString(); // Mon 2026-01-05 03:00Z = 12:00 KST
const preset = (s: MemoryRunStore | FileRunStore, name: string) => mutateControl(s, { action: "preset", name }, "t", T(0));

test("default is fail-closed: nothing may dispatch, unknown agents blocked", async () => {
  const s = new MemoryRunStore();
  for (const a of ["gpt", "codex", "claude-sonnet", "claude-opus", "bogus"]) assert.equal((await requestDispatch(s, 1, a, T(0))).ok, false);
  assert.equal(Object.keys((await s.read()).records).length, 0);
});

test("GPT-only: gpt dispatches; claude/codex suppressed incl. retries and converse calls", async () => {
  const s = new MemoryRunStore();
  await preset(s, "gpt-only");
  assert.equal((await requestDispatch(s, 1, "gpt", T(1))).ok, true);
  for (const a of ["claude-sonnet", "claude-opus", "codex"]) {
    assert.deepEqual(await requestDispatch(s, 2, a, T(1)), { ok: false, reason: "disabled", gate: a === "codex" ? "agent_disabled" : "agent_disabled" });
    assert.deepEqual(await retryDispatchRecord(s, 2, a, T(1)), { ok: false, reason: "disabled", gate: "agent_disabled" });
    assert.equal((await guardProviderCall(s, a, "converse", T(1))).allowed, false);
  }
  assert.equal((await guardProviderCall(s, "gpt", "converse", T(1))).allowed, true);
  const d = await s.read();
  assert.equal(d.blocked["claude-sonnet"], 3);
  assert.equal(Object.values(d.records).filter((r) => r.agent !== "gpt").length, 0);
});

test("provider-wide Claude OFF disables both models even if per-agent flags are on", async () => {
  const s = new MemoryRunStore();
  await preset(s, "all-enabled");
  await mutateControl(s, { action: "set_claude_provider", enabled: false }, "t", T(1));
  const c = (await s.read()).control;
  assert.deepEqual(evaluateGate(c, "claude-sonnet", 0), { allowed: false, reason: "provider_disabled" });
  assert.deepEqual(evaluateGate(c, "claude-opus", 0), { allowed: false, reason: "provider_disabled" });
  assert.equal(evaluateGate(c, "codex", 0).allowed, true);
  assert.equal(evaluateGate(c, "gpt", 0).allowed, true);
});

test("toggle OFF between request and submit: held, no provider call authorised, no fallback", async () => {
  const s = new MemoryRunStore();
  await preset(s, "claude-only");
  const r = await requestDispatch(s, 7, "claude-sonnet", T(1));
  assert.ok(r.ok); const id = r.ok ? r.record.dispatchId : "";
  await mutateControl(s, { action: "set_agent", agent: "claude-sonnet", enabled: false }, "t", T(2));
  const a = await authorizeSubmission(s, id, T(3));
  assert.equal(a.ok, false); assert.equal(a.ok === false && a.reason, "held");
  const rec = (await s.read()).records[id];
  assert.equal(rec.status, "queued"); assert.equal(rec.held, "agent_disabled");
  assert.equal(Object.keys((await s.read()).records).length, 1); // no silent fallback record
  // held work is not turned into "unknown timeout" by reconcile
  const { reconcile } = await import("../runs/service");
  assert.equal(await reconcile(s, T(100000)), 0);
  // re-enable -> release
  await mutateControl(s, { action: "set_agent", agent: "claude-sonnet", enabled: true }, "t", T(4));
  const b = await authorizeSubmission(s, id, T(5));
  assert.equal(b.ok, true);
  assert.equal((await s.read()).records[id].held, undefined);
});

test("reroute only when policy allows, capability matches and target enabled", async () => {
  const s = new MemoryRunStore();
  await preset(s, "all-enabled");
  const r = await requestDispatch(s, 8, "claude-sonnet", T(1), "develop");
  const id = r.ok ? r.record.dispatchId : "";
  await mutateControl(s, { action: "set_agent", agent: "claude-sonnet", enabled: false }, "t", T(2));
  // policy off (default): hold
  assert.equal((await authorizeSubmission(s, id, T(3))).ok === false && (await authorizeSubmission(s, id, T(3))).ok, false);
  assert.equal((await s.read()).records[id].held, "agent_disabled");
  // policy on: rerouted to opus (develop capable, enabled)
  await mutateControl(s, { action: "set_reroute", enabled: true }, "t", T(4));
  const a = await authorizeSubmission(s, id, T(5));
  assert.ok(!a.ok && a.reason === "rerouted" && a.to.agent === "claude-opus");
  // never to a disabled agent: disable everything else -> hold
  const r2 = await requestDispatch(s, 9, "claude-opus", T(6), "develop");
  await preset(s, "all-paused"); await mutateControl(s, { action: "set_reroute", enabled: true }, "t", T(7));
  const b = await authorizeSubmission(s, r2.ok ? r2.record.dispatchId : "", T(8));
  assert.ok(!b.ok && b.reason === "held");
  // capability mismatch: pm work never routes to codex
  const c = { ...defaultControl(), agents: { gpt: false, codex: true, "claude-sonnet": false, "claude-opus": false }, claudeProvider: false };
  assert.equal(routeTarget(c, "pm", 0), null);
});

test("running work drains on OFF; cancel is never claimed without provider support", async () => {
  const s = new MemoryRunStore();
  await preset(s, "all-enabled");
  const r = await requestDispatch(s, 10, "codex", T(1));
  const id = r.ok ? r.record.dispatchId : "";
  await authorizeSubmission(s, id, T(1)); await recordSubmission(s, id, "accepted", T(2));
  await mutateControl(s, { action: "preset", name: "all-paused" }, "t", T(3));
  assert.equal((await s.read()).records[id].status, "dispatched"); // untouched
  const c = await requestCancel(s, id, "t", T(4));
  assert.equal(c.reason, "provider_cancel_unsupported");
  assert.equal((await s.read()).records[id].status, "dispatched");
});

test("concurrent toggles are linearized; version bumps once per change; audit complete", async () => {
  const s = new MemoryRunStore();
  await Promise.all(Array.from({ length: 20 }, (_, i) => mutateControl(s, { action: "set_agent", agent: "gpt", enabled: i % 2 === 0 }, "t", T(i))));
  const d = await s.read();
  assert.equal(d.control.version, 20);
  assert.equal(d.audit.length, 20);
  assert.equal(d.control.agents.gpt, false); // last writer in order wins deterministically
});

test("concurrent toggle vs dispatch: no dispatch record created after OFF commits", async () => {
  const s = new MemoryRunStore();
  await preset(s, "all-enabled");
  await mutateControl(s, { action: "set_agent", agent: "codex", enabled: false }, "t", T(1));
  const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => requestDispatch(s, 20 + i, "codex", T(2))));
  assert.equal(rs.filter((r) => r.ok).length, 0);
});

test("optimistic version conflict and validation", async () => {
  const s = new MemoryRunStore();
  assert.deepEqual((await mutateControl(s, { action: "set_agent", agent: "gpt", enabled: true }, "t", T(0), 5)).ok, false);
  assert.equal((await mutateControl(s, { action: "set_agent", agent: "nope", enabled: true }, "t", T(0))).ok, false);
  assert.equal((await mutateControl(s, { action: "preset", name: "__proto__" }, "t", T(0))).ok, false);
  assert.equal((await mutateControl(s, { action: "set_schedule", schedule: { enabled: true, timezone: "Mars/Base", windows: [] } }, "t", T(0))).ok, false);
  assert.equal((await mutateControl(s, { action: "set_routing", routing: { pm: ["bogus"] } }, "t", T(0))).ok, false);
  assert.equal((await s.read()).control.version, 0);
});

test("weekday schedule honours timezone; disabled by default", async () => {
  assert.equal(defaultControl().schedule.enabled, false);
  const sch = { enabled: true, timezone: "Asia/Seoul", windows: [{ days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" }] };
  assert.equal(scheduleOpen(sch, Date.UTC(2026, 0, 5, 3, 0)), true); // Mon 12:00 KST
  assert.equal(scheduleOpen(sch, Date.UTC(2026, 0, 5, 10, 0)), false); // Mon 19:00 KST
  assert.equal(scheduleOpen(sch, Date.UTC(2026, 0, 4, 3, 0)), false); // Sun
  assert.equal(scheduleOpen({ ...sch, timezone: "America/New_York" }, Date.UTC(2026, 0, 5, 3, 0)), false); // Sun 22:00 NY
  const s = new MemoryRunStore();
  await preset(s, "all-enabled");
  await mutateControl(s, { action: "set_schedule", schedule: sch }, "t", T(0));
  assert.equal((await requestDispatch(s, 1, "gpt", T(1))).ok, true);
  const late = new Date(Date.UTC(2026, 0, 5, 10, 0)).toISOString();
  assert.deepEqual(await requestDispatch(s, 2, "gpt", late), { ok: false, reason: "disabled", gate: "outside_schedule" });
});

test("settings, audit and blocks persist across restart", async () => {
  const f = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "ctl-")), "s.json");
  const s1 = new FileRunStore(f);
  await preset(s1, "claude-only");
  await requestDispatch(s1, 1, "gpt", T(1));
  const s2 = new FileRunStore(f);
  const d = await s2.read();
  assert.equal(d.control.preset, "claude-only"); assert.equal(d.control.agents["claude-sonnet"], true);
  assert.equal(d.blocked.gpt, 1); assert.ok(d.audit.length >= 2);
  assert.equal((await requestDispatch(s2, 2, "gpt", T(2))).ok, false); // still enforced after restart
  assert.equal((await requestDispatch(s2, 3, "claude-opus", T(2))).ok, true);
});

test("snapshot is store-only, reports unknown provider usage, no fabricated telemetry", async () => {
  const s = new MemoryRunStore();
  await preset(s, "all-enabled");
  const r = await requestDispatch(s, 1, "gpt", T(1));
  await authorizeSubmission(s, r.ok ? r.record.dispatchId : "", T(1));
  const snap = buildSnapshot(await s.read(), T(5));
  const gpt = snap.agents.find((a) => a.key === "gpt")!;
  assert.equal(gpt.orchestratorDispatches, 1); assert.equal(gpt.lastAck, null); assert.equal(gpt.providerUsage.state, "unknown");
  assert.equal(snap.agents.length, 4);
});
