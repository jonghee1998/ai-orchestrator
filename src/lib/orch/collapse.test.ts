import assert from "node:assert/strict";
import test from "node:test";
import { COLLAPSED_KEY, readCollapsed, toggleCollapsed, writeCollapsed } from "./collapse";

function mem(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

test("collapse: key name", () => {
  assert.equal(COLLAPSED_KEY, "orch.projects.collapsed");
});

test("readCollapsed: saved array round-trips; missing → [] (all expanded)", () => {
  const s = mem();
  assert.deepEqual(readCollapsed(() => s), []);
  assert.equal(writeCollapsed(() => s, ["o/a", "o/b", "o/a"]), true);
  assert.equal(s.m.get(COLLAPSED_KEY), JSON.stringify(["o/a", "o/b"]));
  assert.deepEqual(readCollapsed(() => s), ["o/a", "o/b"]);
});

test("readCollapsed: broken or odd values → [] or only string names", () => {
  for (const raw of ["{", "null", "3", '"o/a"', '{"o/a":true}', ""]) assert.deepEqual(readCollapsed(() => mem({ [COLLAPSED_KEY]: raw })), [], raw);
  assert.deepEqual(readCollapsed(() => mem({ [COLLAPSED_KEY]: JSON.stringify(["o/a", 1, null, "", "o/a", "o/b"]) })), ["o/a", "o/b"]);
});

test("read/writeCollapsed: storage missing or throwing → default, no throw", () => {
  const boom = () => { throw new Error("SecurityError"); };
  assert.deepEqual(readCollapsed(boom), []);
  assert.deepEqual(readCollapsed(() => null), []);
  assert.deepEqual(readCollapsed(() => ({ getItem: boom, setItem: boom })), []);
  assert.equal(writeCollapsed(boom, ["o/a"]), false);
  assert.equal(writeCollapsed(() => undefined, ["o/a"]), false);
  assert.equal(writeCollapsed(() => ({ getItem: () => null, setItem: boom }), ["o/a"]), false);
});

test("toggleCollapsed: adds or removes one repo without mutating", () => {
  const a = ["o/a"];
  assert.deepEqual(toggleCollapsed(a, "o/b"), ["o/a", "o/b"]);
  assert.deepEqual(toggleCollapsed(a, "o/a"), []);
  assert.deepEqual(a, ["o/a"]);
});
