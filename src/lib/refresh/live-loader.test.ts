import test from "node:test";
import assert from "node:assert/strict";
import { createLiveLoader, type LiveView } from "./live-loader";
import { createOverviewLoader, type OverviewView } from "./overview-loader";
import type { SharedResponse } from "./center";

const R = (status: number, body: unknown): SharedResponse => ({ status, body });
const defer = <T,>() => { let res!: (v: T) => void; const p = new Promise<T>((r) => { res = r; }); return { p, res }; };

function live(responses: Array<SharedResponse | Error | Promise<SharedResponse>>) {
  const views: LiveView<number>[] = [];
  let i = 0;
  const l = createLiveLoader<number>({
    path: "/api/x", getToken: () => "tok",
    accept: () => (st, b) => (st === 200 && typeof (b as any)?.n === "number" ? (b as any).n : null),
    get: async () => { const r = responses[i++]; if (r instanceof Error) throw r; return r; },
    onChange: (v) => views.push(v),
  });
  return { l, views };
}

test("live: HTTP failure on a later poll keeps last good data and surfaces error", async () => {
  const { l, views } = live([R(200, { n: 1 }), R(500, {})]);
  assert.equal(await l.load(), true);
  assert.equal(await l.load(), false);
  const v = views.at(-1)!;
  assert.deepEqual(v.state, { kind: "ok", data: 1 });
  assert.equal(v.error, "HTTP 500");
});
test("live: network error after success keeps data; later success clears error", async () => {
  const { l, views } = live([R(200, { n: 1 }), new Error("boom"), R(200, { n: 2 })]);
  await l.load(); await l.load();
  assert.equal(views.at(-1)!.error, "네트워크 오류");
  assert.deepEqual(views.at(-1)!.state, { kind: "ok", data: 1 });
  await l.load();
  assert.deepEqual(views.at(-1), { state: { kind: "ok", data: 2 }, error: null });
});
test("live: failure before any good data replaces state (no stale to keep); 401 clears", async () => {
  const { l, views } = live([R(500, {}), R(200, { n: 1 }), R(401, {})]);
  await l.load();
  assert.deepEqual(views.at(-1)!.state, { kind: "error", detail: "HTTP 500" });
  await l.load(); await l.load();
  assert.deepEqual(views.at(-1), { state: { kind: "unauth" }, error: null });
});
test("live: stale response race — older slow response cannot overwrite newer one", async () => {
  const slow = defer<SharedResponse>();
  const { l, views } = live([slow.p, R(200, { n: 2 })]);
  const first = l.load();
  assert.equal(await l.load(), true);
  slow.res(R(500, {}));
  assert.equal(await first, false);
  assert.deepEqual(views.at(-1), { state: { kind: "ok", data: 2 }, error: null });
});
test("live: authenticated success with mocked response sends token and returns data", async () => {
  const calls: string[][] = [];
  const views: LiveView<number>[] = [];
  const l = createLiveLoader<number>({ path: "/api/x", getToken: () => " secret ", accept: () => (_s, b) => (b as any).n, get: async (p, t) => { calls.push([p, t]); return R(200, { n: 7 }); }, onChange: (v) => views.push(v) });
  assert.equal(await l.load(), true);
  assert.deepEqual(calls, [["/api/x", "secret"]]);
  assert.deepEqual(views.at(-1)!.state, { kind: "ok", data: 7 });
});
test("live: no token → notoken without fetching", async () => {
  let n = 0;
  const l = createLiveLoader<number>({ path: "/a", getToken: () => "  ", accept: () => () => 1, get: async () => { n++; return R(200, {}); }, onChange: () => {} });
  assert.equal(await l.load(), false);
  assert.equal(n, 0);
  assert.equal(l.getView().state.kind, "notoken");
});

// ---- overview: readiness tracked independently ----
type Snap = { mode: string }; type Ready = { items: string[] };
function ov(map: (path: string, n: number) => SharedResponse | Error | Promise<SharedResponse>) {
  const views: OverviewView<Snap, Ready>[] = [];
  const counts: Record<string, number> = {};
  const l = createOverviewLoader<Snap, Ready>({
    getToken: () => "tok",
    get: async (p) => { counts[p] = (counts[p] ?? 0) + 1; const r = await map(p, counts[p]); if (r instanceof Error) throw r; return r; },
    onChange: (v) => views.push(v),
  });
  return { l, views };
}
const D = R(200, { mode: "live" });
test("overview: authenticated success populates snapshot and readiness", async () => {
  const { l, views } = ov((p) => (p === "/api/dashboard" ? D : R(200, { items: ["a"] })));
  assert.equal(await l.load(), true);
  const v = views.at(-1)!;
  assert.equal(v.state.kind, "ok"); assert.deepEqual(v.ready, { items: ["a"] }); assert.equal(v.readyError, null);
});
test("overview: readiness failure with dashboard success → partial failure, last good readiness retained", async () => {
  const { l, views } = ov((p, n) => (p === "/api/dashboard" ? D : n === 1 ? R(200, { items: ["a"] }) : R(500, {})));
  await l.load();
  assert.equal(await l.load(), false); // 부분 실패는 성공으로 집계되지 않는다
  const v = views.at(-1)!;
  assert.equal(v.state.kind, "ok");
  assert.deepEqual(v.ready, { items: ["a"] });
  assert.equal(v.readyError, "HTTP 500");
  assert.equal(v.staleErr, null);
});
test("overview: readiness network error on first load → ready null (unknown) but dashboard ok", async () => {
  const { l, views } = ov((p) => (p === "/api/dashboard" ? D : new Error("x")));
  assert.equal(await l.load(), false);
  const v = views.at(-1)!;
  assert.equal(v.state.kind, "ok"); assert.equal(v.ready, null); assert.equal(v.readyError, "네트워크 오류");
});
test("overview: readiness recovery clears readyError", async () => {
  const { l, views } = ov((p, n) => (p === "/api/dashboard" ? D : n === 1 ? R(500, {}) : R(200, { items: [] })));
  await l.load(); assert.equal(views.at(-1)!.readyError, "HTTP 500");
  assert.equal(await l.load(), true);
  assert.equal(views.at(-1)!.readyError, null);
});
test("overview: dashboard failure keeps last good snapshot + readiness and reports stale error", async () => {
  const { l, views } = ov((p, n) => (p === "/api/dashboard" ? (n === 1 ? D : R(500, { mode: "error", category: "db" })) : R(200, { items: ["a"] })));
  await l.load();
  assert.equal(await l.load(), false);
  const v = views.at(-1)!;
  assert.equal(v.state.kind, "ok"); assert.deepEqual(v.ready, { items: ["a"] });
  assert.equal(v.staleErr, "HTTP 500 · 원인 분류: db");
});
test("overview: stale response race — older slow load cannot overwrite newer", async () => {
  const slow = defer<SharedResponse>();
  const { l, views } = ov((p, n) => (p === "/api/dashboard" ? (n === 1 ? slow.p : D) : R(200, { items: ["new"] })));
  const first = l.load();
  assert.equal(await l.load(), true);
  slow.res(R(500, {}));
  assert.equal(await first, false);
  const v = views.at(-1)!;
  assert.equal(v.state.kind, "ok"); assert.deepEqual(v.ready, { items: ["new"] }); assert.equal(v.staleErr, null);
});
test("overview: 401 replaces state and clears readiness", async () => {
  const { l, views } = ov((p, n) => (p === "/api/dashboard" ? (n === 1 ? D : R(401, { reason: "token_invalid" })) : R(200, { items: [] })));
  await l.load(); await l.load();
  assert.deepEqual(views.at(-1), { state: { kind: "unauth", reason: "token_invalid" }, ready: null, staleErr: null, readyError: null });
});
