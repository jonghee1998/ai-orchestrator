import assert from "node:assert/strict";
import test from "node:test";
import { refreshSucceeded } from "./refresh";

test("refreshSucceeded: ok 이고 error 없으면 성공", () => {
  assert.equal(refreshSucceeded({ state: { kind: "ok" }, error: null }), true);
});
test("refreshSucceeded: 클릭 전 ok 였어도 reload 뒤 error 가 생기면 실패", () => {
  assert.equal(refreshSucceeded({ state: { kind: "ok" }, error: "network" }), false);
});
test("refreshSucceeded: 클릭 전 error 였어도 reload 뒤 error 가 사라지고 ok 면 성공", () => {
  assert.equal(refreshSucceeded({ state: { kind: "ok" }, error: null }), true);
});
test("refreshSucceeded: ok 가 아닌 상태는 실패", () => {
  for (const kind of ["loading", "error", "unauth", "notoken", "unconfigured"]) assert.equal(refreshSucceeded({ state: { kind }, error: null }), false);
});
