import assert from "node:assert/strict";
import test from "node:test";
import { phaseBoard, type BoardColumn, type BoardItem } from "./lifecycle";
import { parseRoadmap, parseRun, phaseOf, type OrchRun, type RoadmapItem } from "./model";

const TITLES = ["검토", "계획", "개발", "통합"] as const;
const item = (key: string, number: number, o: Partial<BoardItem> = {}): BoardItem =>
  ({ kind: "run", key, title: key, url: "u", sub: "3.7", label: "", at: null, number, phase: null, ...o });
const cols = (...lists: BoardItem[][]): BoardColumn[] => TITLES.map((title, i) => ({ n: (i + 1) as 1 | 2 | 3 | 4, title, items: lists[i] ?? [] }));
const ph = (id: string, status: RoadmapItem["status"] = "todo", o: Partial<RoadmapItem> = {}): RoadmapItem =>
  ({ id, title: `단계 ${id}`, status, note: null, ref: null, tasks: [], ...o });
const task = (title: string, status: "done" | "todo" = "todo") => ({ title, owner: "ai" as const, status });
const keys = (g: { items: BoardItem[] }) => g.items.map((i) => i.key);
const run = (number: number, status: OrchRun["status"], phase: string | null = null) => ({ number, status, phase }) as OrchRun;

test("phaseBoard: explicit phase id links; unknown / null phase → 단계 미지정 (last)", () => {
  const b = phaseBoard(cols([], [], [item("a", 1, { phase: "P2" }), item("b", 2, { phase: "zz" }), item("c", 3, { phase: "P1" }), item("d", 4)]), [ph("P1", "doing"), ph("P2", "doing")], []);
  assert.deepEqual(b.columns.map((c) => c.n), [1, 2, 3, 4]);
  const g = b.columns[2].groups;
  assert.deepEqual(g.map((x) => x.phase?.id ?? null), ["P1", "P2", null]);
  assert.deepEqual(g.map(keys), [["c"], ["a"], ["b", "d"]]);
});

test("phaseBoard: ref links when no phase; explicit phase wins over a different ref", () => {
  const phases = [ph("1", "doing", { ref: 10 }), ph("2", "doing", { ref: 20 })];
  const b = phaseBoard(cols([], [], [item("r10", 10), item("r20", 20, { phase: "1" })]), phases, []);
  const g = b.columns[2].groups;
  assert.deepEqual(g.map((x) => x.phase?.id), ["1"]);
  assert.deepEqual(keys(g[0]), ["r10", "r20"]);
  assert.equal(b.columns[1].groups.length, 1); // phase 2 has no item → 예정
  assert.deepEqual([b.columns[1].groups[0].phase?.id, b.columns[1].groups[0].items], ["2", []]);
});

test("phaseBoard: doing phase linked by ref sits in its column, not 예정", () => {
  const b = phaseBoard(cols([], [], [], [item("r", 7)]), [ph("6", "doing", { ref: 7 })], []);
  assert.deepEqual(b.columns.map((c) => c.groups.length), [0, 0, 0, 1]);
});

test("phaseBoard: group order follows the phases array (non-numeric ids), 단계 미지정 last", () => {
  const phases = [ph("P10", "doing"), ph("Alpha", "doing"), ph("P2", "doing")];
  const b = phaseBoard(cols([], [], [item("x", 1), item("a", 2, { phase: "P2" }), item("b", 3, { phase: "P10" }), item("c", 4, { phase: "Alpha" })]), phases, []);
  assert.deepEqual(b.columns[2].groups.map((g) => g.phase?.id ?? null), ["P10", "Alpha", "P2", null]);
});

test("phaseBoard: a phase across columns gets a group per column; tasks only on the first", () => {
  const p = ph("1", "doing", { tasks: [task("a"), task("b", "done"), task("c")] });
  const b = phaseBoard(cols([], [item("pl", 1, { kind: "plan", phase: "1" })], [item("r", 2, { phase: "1" })]), [p], []);
  assert.deepEqual(b.columns[1].groups[0].tasks.map((t) => t.title), ["a", "c"]);
  assert.deepEqual(b.columns[2].groups[0].tasks, []);
  assert.equal(b.columns[2].groups[0].phase, p);
});

test("phaseBoard: done phases leave the columns with their finished run numbers", () => {
  const phases = [ph("1", "done", { ref: 5 }), ph("2", "done"), ph("3", "doing")];
  const runs = [run(5, "done"), run(6, "done", "2"), run(7, "implementing", "2"), run(8, "done", "3"), run(9, "done", "1")];
  const b = phaseBoard(cols([], [], [item("r7", 7, { phase: "2" }), item("r", 1, { phase: "3" })]), phases, runs);
  assert.deepEqual(b.done.map((d) => [d.phase.id, d.runs]), [["1", [5, 9]], ["2", [6]]]);
  assert.deepEqual(b.columns[2].groups.map((g) => g.phase?.id ?? null), ["3", null]);
});

test("phaseBoard: todo phase without items → 계획 칸 '예정' with tasks, in phases order", () => {
  const phases = [ph("1", "doing"), ph("2", "todo", { tasks: [task("t")] }), ph("3", "doing")];
  const b = phaseBoard(cols([], [item("a", 1, { kind: "plan", phase: "1" }), item("c", 2, { kind: "plan", phase: "3" }), item("u", 3, { kind: "plan" })]), phases, []);
  const g = b.columns[1].groups;
  assert.deepEqual(g.map((x) => x.phase?.id ?? null), ["1", "2", "3", null]);
  assert.deepEqual([g[1].items, g[1].tasks.map((t) => t.title)], [[], ["t"]]);
});

test("phaseBoard: ideas always 단계 미지정; input not mutated", () => {
  const input = cols([item("i", 4, { kind: "idea", phase: "1" })], [], [item("r", 1, { phase: "1" })]);
  const phases = [ph("1", "doing", { ref: 4 }), ph("2", "todo", { tasks: [task("t")] })];
  const snap = JSON.stringify([input, phases]);
  const b = phaseBoard(input, phases, []);
  assert.deepEqual(b.columns[0].groups.map((g) => g.phase), [null]);
  assert.equal(JSON.stringify([input, phases]), snap);
});

test("model: run.phase parsed from plan JSON (string, integer, bad, missing)", () => {
  const issue = (extra: object) => ({ number: 1, html_url: "u", title: "t", body: "```json\n" + JSON.stringify({ goal: "g", steps: [], ...extra }) + "\n```" });
  const phase = (extra: object) => parseRun("o/r", issue(extra))!.phase;
  assert.equal(phase({ phase: "6" }), "6");
  assert.equal(phase({ phase: 6 }), "6");
  assert.equal(phase({ phase: " P1 " }), "P1");
  assert.equal(phase({ phase: "12345678901" }), null);
  assert.equal(phase({ phase: "" }), null);
  assert.equal(phase({ phase: 1.5 }), null);
  assert.equal(phase({ phase: { a: 1 } }), null);
  assert.equal(phase({}), null);
  assert.equal(phaseOf(null), null);
});

test("model: roadmap tasks parsed; bad items dropped, title cut to 40, missing → []", () => {
  const r = parseRoadmap(JSON.stringify({ phases: [
    { id: "1", title: "a", tasks: [
      { title: "가".repeat(60), owner: "me", status: "done" },
      { title: "ok", owner: "ai", status: "todo" },
      { title: "", owner: "ai", status: "todo" },
      { title: "x", owner: "bot", status: "todo" },
      { title: "y", owner: "me", status: "doing" },
      "str", null,
    ] },
    { id: "2", title: "b", tasks: "nope" },
    { id: "3", title: "c" },
  ] }))!;
  assert.deepEqual(r.phases[0].tasks.map((t) => [t.title.length, t.owner, t.status]), [[40, "me", "done"], [2, "ai", "todo"]]);
  assert.deepEqual([r.phases[1].tasks, r.phases[2].tasks], [[], []]);
});
