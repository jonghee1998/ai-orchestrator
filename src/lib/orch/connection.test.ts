import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { ENGINE_WORKFLOWS, connectionCheck, markEngineDrift, type ConnectionCheck, type ConnectionInput, type RepoView } from "./model";

const SHA = (c: string) => c.repeat(40);
const file = (name: string, sha = SHA("a")) => ({ name, type: "file", sha });
const dir = (name: string, sha = SHA("b")) => ({ name, type: "dir", sha });

const full = (): ConnectionInput => ({
  root: [file("CLAUDE.md"), file("AGENTS.md"), dir("docs"), dir("scripts"), dir(".github")],
  docs: [file("roadmap.json"), file("architecture.json"), file("PM_HANDOFF.md")],
  workflows: [...ENGINE_WORKFLOWS.map((n) => file(n)), file("ci.yml"), file("deploy.yml")],
  scripts: [dir("orch", SHA("c")), file("other.mjs")],
  label: true,
});

const byKey = (c: ConnectionCheck, key: string) => c.items.find((i) => i.key === key)!;

test("ENGINE_WORKFLOWS equals .github/workflows *.yml minus ci.yml and deploy.yml", () => {
  const onDisk = fs.readdirSync(".github/workflows").filter((n) => n.endsWith(".yml") && n !== "ci.yml" && n !== "deploy.yml").sort();
  assert.deepEqual([...ENGINE_WORKFLOWS], onDisk);
  assert.equal(ENGINE_WORKFLOWS.length, 13);
});

test("connectionCheck: everything present → done 9, total 9, all ok true, engine shas", () => {
  const c = connectionCheck(full());
  assert.deepEqual(c.items.map((i) => i.key), ["workflows", "ci", "orch", "claude", "agents", "roadmap", "architecture", "handoff", "label"]);
  assert.ok(c.items.every((i) => i.ok === true));
  assert.equal(c.done, 9);
  assert.equal(c.total, 9);
  assert.equal(c.engine.orchSha, SHA("c"));
  assert.deepEqual(Object.keys(c.engine.workflowShas), [...ENGINE_WORKFLOWS]);
  assert.ok(!("ci.yml" in c.engine.workflowShas));
  assert.equal(c.engineSame, null);
  assert.deepEqual(c.engineDiff, []);
  assert.equal(byKey(c, "label").label, "라벨 orch:go");
});

test("connectionCheck: workflows 'missing' → workflows and ci ok false, missing = all ENGINE_WORKFLOWS", () => {
  const c = connectionCheck({ ...full(), workflows: "missing" });
  assert.equal(byKey(c, "workflows").ok, false);
  assert.deepEqual(byKey(c, "workflows").missing, [...ENGINE_WORKFLOWS]);
  assert.equal(byKey(c, "ci").ok, false);
  assert.equal(c.done, 7);
  assert.equal(c.total, 9);
  assert.deepEqual(c.engine.workflowShas, {});
});

test("connectionCheck: two workflows missing → missing lists those two sorted", () => {
  const input = full();
  input.workflows = (input.workflows as { name: string; type: string; sha: string }[]).filter((f) => f.name !== "wait.yml" && f.name !== "claude-work.yml");
  const c = connectionCheck(input);
  assert.equal(byKey(c, "workflows").ok, false);
  assert.deepEqual(byKey(c, "workflows").missing, ["claude-work.yml", "wait.yml"]);
  assert.equal(byKey(c, "ci").ok, true);
  assert.equal(c.done, 8);
});

test("connectionCheck: docs 'error' → roadmap/architecture/handoff ok null, total 6", () => {
  const c = connectionCheck({ ...full(), docs: "error" });
  for (const k of ["roadmap", "architecture", "handoff"]) assert.equal(byKey(c, k).ok, null);
  assert.equal(c.total, 6);
  assert.equal(c.done, 6);
});

test("connectionCheck: scripts without orch dir / orch as file → orch false, orchSha null", () => {
  const c = connectionCheck({ ...full(), scripts: [file("orch")] });
  assert.equal(byKey(c, "orch").ok, false);
  assert.equal(c.engine.orchSha, null);
  const m = connectionCheck({ ...full(), scripts: "missing", root: "error" });
  assert.equal(byKey(m, "orch").ok, false);
  assert.equal(byKey(m, "claude").ok, null);
  assert.equal(byKey(m, "agents").ok, null);
});

test("connectionCheck: label false → ok false; null → ok null", () => {
  const f = connectionCheck({ ...full(), label: false });
  assert.equal(byKey(f, "label").ok, false);
  assert.equal(f.done, 8);
  assert.equal(f.total, 9);
  const n = connectionCheck({ ...full(), label: null });
  assert.equal(byKey(n, "label").ok, null);
  assert.equal(n.total, 8);
});

const view = (repo: string, isSelf: boolean, connection: ConnectionCheck | null | undefined): RepoView => ({
  repo, plans: [], plansError: null, ideas: [], ideasError: null, switches: null, switchesError: null, runs: [], runsError: null,
  roadmap: null, roadmapError: null, deployPending: null, deployMode: "unknown", app: null, deployEvery: 10, isSelf, connection,
});

test("markEngineDrift: same engine → engineSame true; self stays null", () => {
  const out = markEngineDrift([view("o/self", true, connectionCheck(full())), view("o/a", false, connectionCheck(full()))]);
  assert.equal(out[0].connection!.engineSame, null);
  assert.equal(out[1].connection!.engineSame, true);
  assert.deepEqual(out[1].connection!.engineDiff, []);
});

test("markEngineDrift: orch sha differs → engineDiff ['scripts/orch']", () => {
  const other = connectionCheck({ ...full(), scripts: [dir("orch", SHA("d"))] });
  const out = markEngineDrift([view("o/self", true, connectionCheck(full())), view("o/a", false, other)]);
  assert.equal(out[1].connection!.engineSame, false);
  assert.deepEqual(out[1].connection!.engineDiff, ["scripts/orch"]);
});

test("markEngineDrift: one workflow sha differs and one only on one side → those file names sorted", () => {
  const input = full();
  input.workflows = ENGINE_WORKFLOWS.filter((n) => n !== "usage.yml").map((n) => file(n, n === "claude-work.yml" ? SHA("e") : SHA("a")));
  const out = markEngineDrift([view("o/a", false, connectionCheck(input)), view("o/self", true, connectionCheck(full()))]);
  assert.deepEqual(out[0].connection!.engineDiff, ["claude-work.yml", "usage.yml"]);
  assert.equal(out[0].connection!.engineSame, false);
  assert.equal(out[1].connection!.engineSame, null);
});

test("markEngineDrift: no reference / null connection / null orchSha → engineSame null, engineDiff []", () => {
  const noSelf = markEngineDrift([view("o/a", false, connectionCheck(full()))]);
  assert.equal(noSelf[0].connection!.engineSame, null);
  assert.deepEqual(noSelf[0].connection!.engineDiff, []);
  const selfNull = markEngineDrift([view("o/self", true, null), view("o/a", false, connectionCheck(full()))]);
  assert.equal(selfNull[1].connection!.engineSame, null);
  const noOrch = markEngineDrift([view("o/self", true, connectionCheck(full())), view("o/a", false, connectionCheck({ ...full(), scripts: "missing" }))]);
  assert.equal(noOrch[1].connection!.engineSame, null);
  assert.deepEqual(noOrch[1].connection!.engineDiff, []);
  const selfNoOrch = markEngineDrift([view("o/self", true, connectionCheck({ ...full(), scripts: "error" })), view("o/a", false, connectionCheck(full()))]);
  assert.equal(selfNoOrch[1].connection!.engineSame, null);
  const missingConn = markEngineDrift([view("o/self", true, connectionCheck(full())), view("o/a", false, undefined)]);
  assert.equal(missingConn[1].connection ?? null, null);
});

test("markEngineDrift: does not mutate input; returns new objects", () => {
  const other = connectionCheck({ ...full(), scripts: [dir("orch", SHA("d"))] });
  const input = [view("o/self", true, connectionCheck(full())), view("o/a", false, other)];
  const snapshot = JSON.parse(JSON.stringify(input));
  const out = markEngineDrift(input);
  assert.deepEqual(input, snapshot);
  assert.notEqual(out, input);
  assert.notEqual(out[1], input[1]);
  assert.notEqual(out[1].connection, input[1].connection);
  assert.equal(input[1].connection!.engineSame, null);
});
