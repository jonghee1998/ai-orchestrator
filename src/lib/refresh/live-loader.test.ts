import test from "node:test";
import assert from "node:assert/strict";
import { createLiveLoader, type LiveView } from "./live-loader";
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
