import test from "node:test";
import assert from "node:assert/strict";
import { createRefreshCenter, createSharedGet } from "./center";

const tick = () => new Promise((r) => setTimeout(r, 0));

test("refreshAll runs every registered loader immediately and records last success", async () => {
  let t = 1000; const c = createRefreshCenter(() => t);
  const calls: string[] = [];
  c.register("a", async () => { calls.push("a"); return true; });
  c.register("b", async () => { calls.push("b"); return true; });
  const snap = await c.refreshAll();
  assert.deepEqual(calls.sort(), ["a", "b"]);
  assert.equal(snap.lastSuccessAt, 1000); assert.deepEqual(snap.failed, []); assert.equal(snap.inFlight, false);
});

test("concurrent clicks dedupe into one run; loading flag is set while in flight", async () => {
  const c = createRefreshCenter(); let n = 0; let release!: () => void;
  c.register("a", () => new Promise<boolean>((res) => { n++; release = () => res(true); }));
  const p1 = c.refreshAll(); const p2 = c.refreshAll(); const p3 = c.refreshAll();
  assert.equal(p1, p2); assert.equal(p2, p3);
  assert.equal(c.getSnapshot().inFlight, true);
  await tick(); release(); await p1;
  assert.equal(n, 1); assert.equal(c.getSnapshot().inFlight, false);
  const p4 = c.refreshAll(); await tick(); release(); await p4; assert.equal(n, 2, "a new click after completion runs again");
});

test("partial failure is reported, timestamp still advances, throwing loader counts as failure", async () => {
  let t = 5; const c = createRefreshCenter(() => t);
  c.register("ok", async () => true); c.register("bad", async () => false); c.register("boom", async () => { throw new Error("x"); });
  const s = await c.refreshAll();
  assert.deepEqual(s.failed.sort(), ["bad", "boom"]); assert.equal(s.lastSuccessAt, 5);
});

test("total failure keeps the previous successful timestamp (no fake refresh)", async () => {
  let t = 10; const c = createRefreshCenter(() => t); let ok = true;
  c.register("a", async () => ok);
  await c.refreshAll(); assert.equal(c.getSnapshot().lastSuccessAt, 10);
  t = 20; ok = false; const s = await c.refreshAll();
  assert.equal(s.lastSuccessAt, 10); assert.deepEqual(s.failed, ["a"]);
});

test("unregistered loaders are not called; subscribers are notified", async () => {
  const c = createRefreshCenter(); let n = 0; let notified = 0;
  c.subscribe(() => notified++);
  const off = c.register("a", async () => { n++; return true; }); off();
  await c.refreshAll(); assert.equal(n, 0); assert.ok(notified > 0);
});

test("sharedGet dedupes concurrent identical GETs, separates tokens/paths, and does not cache after settle", async () => {
  let n = 0; const seen: string[] = [];
  const f = async (p: string, init: { headers: Record<string, string> }) => { n++; seen.push(`${p}|${init.headers["x-admin-token"]}`); await tick(); return { status: 200, json: async () => ({ p }) }; };
  const g = createSharedGet(f as never);
  const [a, b] = await Promise.all([g("/api/dashboard", "t"), g("/api/dashboard", "t")]);
  assert.equal(n, 1); assert.equal(a, b);
  await Promise.all([g("/api/dashboard", "u"), g("/api/runs", "t")]); assert.equal(n, 3);
  await g("/api/dashboard", "t"); assert.equal(n, 4);
  assert.ok(seen.every((s) => s.includes("|")));
});

test("sharedGet: rejected fetch clears pending so next call retries", async () => {
  let n = 0; const g = createSharedGet((async () => { n++; if (n === 1) throw new Error("net"); return { status: 200, json: async () => ({}) }; }) as never);
  await assert.rejects(g("/x", "t")); await g("/x", "t"); assert.equal(n, 2);
});
