import test from "node:test";
import assert from "node:assert/strict";
import { CURRENT_VERSION, PATCH_NOTES, groupByMajor } from "./patchnotes";

const parse = (v: string) => v.split(".").map(Number);
function cmp(a: string, b: string) {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

test("patch notes are well-formed", () => {
  for (const n of PATCH_NOTES) {
    assert.match(n.version, /^\d+\.\d+\.\d+$/);
    assert.match(n.date, /^\d{4}-\d{2}-\d{2}$/);
    if (n.pr !== undefined) assert.ok(Number.isInteger(n.pr) && n.pr > 0);
    assert.ok(n.items.length >= 1);
    assert.ok(n.title.length > 0);
  }
});

test("patch notes are strictly descending by version", () => {
  for (let i = 1; i < PATCH_NOTES.length; i++) {
    assert.ok(cmp(PATCH_NOTES[i - 1].version, PATCH_NOTES[i].version) > 0, PATCH_NOTES[i].version);
  }
});

test("current version and first/last entries", () => {
  assert.equal(CURRENT_VERSION, PATCH_NOTES[0].version);
  assert.equal(PATCH_NOTES[PATCH_NOTES.length - 1].version, "1.0.0");
  // 항목 수는 고정하지 않는다: 새 릴리스마다 맨 앞에 추가된다.
  assert.ok(PATCH_NOTES.length >= 11);
});

test("groupByMajor: newest major first, every note kept in order", () => {
  const g = groupByMajor(PATCH_NOTES);
  assert.equal(g[0].major, Number(CURRENT_VERSION.split(".")[0]));
  assert.deepEqual(g.map((x) => x.major), [...g.map((x) => x.major)].sort((a, b) => b - a));
  assert.deepEqual(g.flatMap((x) => x.notes), PATCH_NOTES);
  assert.deepEqual(groupByMajor([{ version: "2.0.0", date: "2026-01-01", title: "t", items: ["a"] }, { version: "1.2.0", date: "2026-01-01", title: "t", items: ["a"] }, { version: "1.0.0", date: "2026-01-01", title: "t", items: ["a"] }]).map((x) => [x.major, x.notes.length]), [[2, 1], [1, 2]]);
});
