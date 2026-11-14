import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitHubLabelAdapter, dispatchIssue, submitQueued, type DispatchAdapter } from "./dispatcher";
import { FileRunStore, MemoryRunStore, getRunStore, RunStoreConfigurationError } from "./store";
import { PgRunStore, type SqlPool } from "./pg-store";
import { mutateControl } from "../control/service";
import { reconcile, requestDispatch, retryDispatchRecord } from "./service";
import { checkRead } from "../control/auth";
import { defaultControl, PRESETS } from "../control/model";

const NOW = "2026-01-01T00:00:00.000Z";
const spy = () => { const calls: string[] = []; const a: DispatchAdapter = { supports: () => true, submit: async (r, k) => { calls.push(k); return { outcome: "accepted" }; } }; return { a, calls }; };
const preset = (s: MemoryRunStore, name: keyof typeof PRESETS) => mutateControl(s, { action: "preset", name }, "t", NOW);

test("GPT-only: claude never reaches provider; gpt unsupported by adapter => no call", async () => {
  const s = new MemoryRunStore(); await preset(s, "gpt-only"); const { a, calls } = spy();
  const r = await dispatchIssue(s, a, 1, "claude-sonnet", NOW);
  assert.deepEqual([r.ok, calls.length], [false, 0]);
});

test("Claude-only: claude dispatched once, gpt blocked, duplicate rejected", async () => {
  const s = new MemoryRunStore(); await preset(s, "claude-only"); const { a, calls } = spy();
  assert.equal((await dispatchIssue(s, a, 2, "claude-sonnet", NOW)).ok, true);
  assert.equal((await dispatchIssue(s, a, 2, "claude-sonnet", NOW)).ok, false);
  assert.equal((await dispatchIssue(s, a, 2, "gpt", NOW)).ok, false);
  assert.equal(calls.length, 1);
});

test("OFF race: toggle OFF between request and submit => held, zero provider calls", async () => {
  const s = new MemoryRunStore(); await preset(s, "claude-only"); const { a, calls } = spy();
  const req = await requestDispatch(s, 3, "claude-sonnet", NOW);
  assert.ok(req.ok);
  await preset(s, "all-paused");
  const r = await submitQueued(s, a, (req as { record: { dispatchId: string } }).record.dispatchId, NOW);
  assert.equal(r.ok, false); assert.equal(calls.length, 0);
  assert.equal((await s.read()).records["d-3-claude-sonnet-1"].held, "agent_disabled");
});

test("lost ACK / timeout => unknown, not auto-retried; HTTP 4xx => rejected and retryable", async () => {
  const s = new MemoryRunStore(); await preset(s, "claude-only");
  const bad = new GitHubLabelAdapter({ token: "t", repo: "o/r" }, (async () => { throw new Error("secret-token-xyz"); }) as typeof fetch);
  const r = await dispatchIssue(s, bad, 4, "claude-sonnet", NOW);
  assert.equal(r.ok && r.record.submission, "unknown");
  assert.ok(!JSON.stringify(await s.read()).includes("secret-token-xyz"));
  const rr = await retryDispatchRecord(s, 4, "claude-sonnet", NOW); assert.equal(rr.ok, false);
  const s2 = new MemoryRunStore(); await preset(s2, "claude-only");
  const rej = new GitHubLabelAdapter({ token: "t", repo: "o/r" }, (async () => new Response("", { status: 404 })) as typeof fetch);
  assert.equal((await dispatchIssue(s2, rej, 5, "claude-sonnet", NOW)).ok, false);
  assert.equal((await retryDispatchRecord(s2, 5, "claude-sonnet", NOW)).ok, true);
});

test("GitHub adapter request shape: labels, no token in body, codex label", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const ad = new GitHubLabelAdapter({ token: "tok", repo: "o/r" }, (async (u: string, i: RequestInit) => { seen = { url: u, init: i }; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch);
  await ad.submit({ dispatchId: "d-9-codex-1", issueNumber: 9, agent: "codex" } as never, "d-9-codex-1");
  assert.equal(seen!.url, "https://api.github.com/repos/o/r/issues/9/labels");
  assert.deepEqual(JSON.parse(seen!.init.body as string), { labels: ["agent:codex", "status:ready"] });
  assert.equal(ad.supports("gpt"), false);
});

test("restart: queued-never-submitted becomes unknown after reconcile on a fresh FileRunStore; held survives", async () => {
  const f = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "rs-")), "s.json");
  const s1 = new FileRunStore(f);
  await s1.transact((d) => { d.control = { ...d.control, agents: { ...d.control.agents, "claude-sonnet": true }, claudeProvider: true }; });
  await requestDispatch(s1, 6, "claude-sonnet", NOW);
  const s2 = new FileRunStore(f); // "restart"
  assert.equal(await reconcile(s2, "2026-01-01T01:00:00.000Z"), 1);
  const rec = (await s2.read()).records["d-6-claude-sonnet-1"];
  assert.deepEqual([rec.status, rec.submission], ["timeout", "unknown"]);
});

test("store selection: serverless forbids file fallback; DATABASE_URL selects Postgres", () => {
  assert.throws(() => getRunStore({ VERCEL: "1", RUN_STORE_PATH: "/tmp/x" }), RunStoreConfigurationError);
  assert.throws(() => getRunStore({}), RunStoreConfigurationError);
  assert.ok(getRunStore({ DATABASE_URL: "postgres://u@h/d" }));
});

test("PgRunStore: single locked row, SELECT FOR UPDATE, commit/rollback via pool", async () => {
  const log: string[] = []; let data = JSON.stringify({ records: {}, events: {}, audit: [], blocked: {} });
  const pool: SqlPool = { withTransaction: async (fn) => fn({ query: async (sql, p) => { log.push(sql.split(" ")[0] + (sql.includes("FOR UPDATE") ? " FOR UPDATE" : "")); if (sql.startsWith("UPDATE")) data = p![0] as string; return { rows: sql.startsWith("SELECT") ? [{ data: JSON.parse(data) }] : [] }; } }) };
  const s = new PgRunStore(pool, () => ({ records: {}, events: {}, audit: [], blocked: {}, control: defaultControl() }), (r) => ({ records: {}, events: {}, audit: [], blocked: {}, control: defaultControl(), ...r } as never));
  await s.transact((d) => { d.blocked.x = 1; });
  assert.equal((await s.read()).blocked.x, 1);
  assert.ok(log.includes("SELECT FOR UPDATE"));
});

test("read auth: fail closed, read or admin token accepted", () => {
  const e = { CONTROL_READ_TOKEN: "r".repeat(16), CONTROL_ADMIN_TOKEN: "a".repeat(20) };
  assert.deepEqual(checkRead("x", {}), { ok: false, status: 503 });
  assert.deepEqual(checkRead(null, e), { ok: false, status: 401 });
  assert.equal(checkRead("r".repeat(16), e).ok, true);
  assert.equal(checkRead("a".repeat(20), e).ok, true);
});
