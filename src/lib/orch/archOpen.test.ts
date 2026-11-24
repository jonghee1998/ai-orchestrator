import test from "node:test";
import assert from "node:assert/strict";
import { ARCH_OPEN_KEY, boxLineCount, boxMaxChars, fitLine, readArchOpen, toggleArchOpen, writeArchOpen } from "./archOpen";

test("readArchOpen: bad values or blocked storage → all collapsed", () => {
  const mk = (v: string | null) => () => ({ getItem: () => v, setItem: () => {} });
  assert.deepEqual(readArchOpen(mk(null)), []);
  assert.deepEqual(readArchOpen(mk("{oops")), []);
  assert.deepEqual(readArchOpen(mk("5")), []);
  assert.deepEqual(readArchOpen(mk('["self",3,"","self","x/y"]')), ["self", "x/y"]);
  assert.deepEqual(readArchOpen(() => { throw new Error("blocked"); }), []);
});

test("writeArchOpen / toggleArchOpen", () => {
  const got: string[] = [];
  assert.equal(writeArchOpen(() => ({ getItem: () => null, setItem: (k, v) => { got.push(k, v); } }), ["a", "a"]), true);
  assert.deepEqual(got, [ARCH_OPEN_KEY, '["a"]']);
  assert.equal(writeArchOpen(() => { throw new Error("x"); }, ["a"]), false);
  assert.deepEqual(toggleArchOpen(["a"], "b"), ["a", "b"]);
  assert.deepEqual(toggleArchOpen(["a", "b"], "a"), ["b"]);
});

test("diagram box text fitting", () => {
  assert.equal(boxLineCount(18, 2), 0);
  assert.equal(boxLineCount(20, 2), 1);
  assert.equal(boxLineCount(48, 3), 3);
  assert.equal(boxLineCount(48, 2), 2);
  assert.equal(boxMaxChars(16), 0);
  assert.equal(boxMaxChars(22), 0);
  assert.equal(boxMaxChars(23), 1);
  assert.equal(boxMaxChars(100), 8);
  assert.equal(fitLine("가나다라", 8), "가나다라");
  assert.equal(fitLine("가나다라마바사아자", 5), "가나다라…");
  assert.equal(fitLine("가나", 1), "…");
  assert.equal(fitLine("가나", 0), "");
});
