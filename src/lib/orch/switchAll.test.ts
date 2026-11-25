import assert from "node:assert/strict";
import test from "node:test";
import { mergedSwitches, switchesFromVars, type RepoView, type Switches } from "./model";
import { applySwitchAll, type SwitchWriter } from "./switchAll";

const ON: Switches = { sonnet: true, opus: true, fable: true, codex: true, paused: false, auto: false, codexDev: true, window: "" };
const view = (repo: string, switches: Switches | null, isSelf = false): RepoView => ({
  repo, plans: [], plansError: null, ideas: [], ideasError: null, switches, switchesError: switches ? null : "권한 없음 또는 저장소 없음",
  runs: [], runsError: null, roadmap: null, roadmapError: null, deployPending: null, deployMode: "unknown", app: null, deployEvery: 10, isSelf,
});

// ---------------------------------------------------------------- mergedSwitches

test("mergedSwitches: all repos equal → own repo value, no differences", () => {
  const m = mergedSwitches([view("o/a", ON), view("o/self", ON, true), view("o/b", { ...ON })]);
  assert.deepEqual(m, { value: ON, differs: [], unreadable: [] });
});

test("mergedSwitches: own repo (isSelf) is the reference, differences listed per key in FLAG_KEYS order", () => {
  const self = { ...ON, codex: false, paused: true };
  const m = mergedSwitches([
    view("o/a", ON), // differs on codex + paused
    view("o/self", self, true),
    view("o/b", { ...self, sonnet: false }), // differs on sonnet only
  ]);
  assert.deepEqual(m.value, self, "never the first repo's values");
  assert.deepEqual(m.differs, [
    { key: "sonnet", repos: ["o/b"] },
    { key: "codex", repos: ["o/a"] },
    { key: "paused", repos: ["o/a"] },
  ]);
  assert.deepEqual(m.unreadable, []);
});

test("mergedSwitches: window differences are compared too", () => {
  const m = mergedSwitches([view("o/self", { ...ON, window: "08:00-24:00" }, true), view("o/a", ON), view("o/b", { ...ON, window: "08:00-24:00" })]);
  assert.deepEqual(m.differs, [{ key: "window", repos: ["o/a"] }]);
});

test("mergedSwitches: unreadable repos are listed separately, not counted as different", () => {
  const m = mergedSwitches([view("o/self", ON, true), view("o/a", null), view("o/b", { ...ON, opus: false })]);
  assert.deepEqual(m.value, ON);
  assert.deepEqual(m.differs, [{ key: "opus", repos: ["o/b"] }]);
  assert.deepEqual(m.unreadable, ["o/a"]);
});

test("mergedSwitches: own repo unreadable → value null (a default-valued repo never becomes the reference)", () => {
  const m = mergedSwitches([view("o/a", ON), view("o/self", null, true), view("o/b", { ...ON, paused: true })]);
  assert.deepEqual(m, { value: null, differs: [], unreadable: ["o/self"] });
  const none = mergedSwitches([view("o/a", ON), view("o/b", ON)]);
  assert.equal(none.value, null, "no isSelf repo → null too");
});

test("mergedSwitches: every repo unreadable → value null, all listed", () => {
  assert.deepEqual(mergedSwitches([view("o/self", null, true), view("o/a", null)]), { value: null, differs: [], unreadable: ["o/self", "o/a"] });
  assert.deepEqual(mergedSwitches([]), { value: null, differs: [], unreadable: [] });
});

// ---------------------------------------------------------------- applySwitchAll

type W = { calls: string[]; writer: SwitchWriter };
const fakeWriter = (saveFail: string[] = [], wakeFail: string[] = []): W => {
  const calls: string[] = [];
  return {
    calls,
    writer: async (repo, name, value) => {
      calls.push(`${repo} ${name}=${value}`);
      if (saveFail.includes(repo)) throw new Error("boom");
      return { woke: !wakeFail.includes(repo) };
    },
  };
};
const REPOS = ["o/a", "o/b", "o/c"];

test("applySwitchAll: every repo saved and woken → ok true, one write per repo in order", async () => {
  const w = fakeWriter();
  const out = await applySwitchAll(REPOS, "codex", false, w.writer);
  assert.deepEqual(out, {
    kind: "done", name: "ORCH_CODEX", value: "off",
    result: { ok: true, results: REPOS.map((repo) => ({ repo, saved: true, woke: true })) },
  });
  assert.deepEqual(w.calls, ["o/a ORCH_CODEX=off", "o/b ORCH_CODEX=off", "o/c ORCH_CODEX=off"]);
});

test("applySwitchAll: one repo fails to save → recorded, the rest still written, ok false", async () => {
  const w = fakeWriter(["o/a"]);
  const out = await applySwitchAll(REPOS, "window", " 08:00-24:00 ", w.writer, () => "권한 없음 또는 저장소 없음");
  assert.equal(out.kind, "done");
  if (out.kind !== "done") return;
  assert.deepEqual(out.result, {
    ok: false,
    results: [
      { repo: "o/a", saved: false, woke: false, error: "권한 없음 또는 저장소 없음" },
      { repo: "o/b", saved: true, woke: true },
      { repo: "o/c", saved: true, woke: true },
    ],
  });
  assert.equal(w.calls.length, 3, "continued after the failure");
  assert.ok(w.calls.every((c) => c.endsWith("ORCH_WINDOW=08:00-24:00")));
});

test("applySwitchAll: saved but wake failed → saved true woke false, still ok", async () => {
  const out = await applySwitchAll(REPOS, "paused", true, fakeWriter([], ["o/b"]).writer);
  assert.equal(out.kind, "done");
  if (out.kind !== "done") return;
  assert.equal(out.result.ok, true);
  assert.deepEqual(out.result.results[1], { repo: "o/b", saved: true, woke: false });
});

test("applySwitchAll: no target repos → ok false, results []", async () => {
  const w = fakeWriter();
  assert.deepEqual(await applySwitchAll([], "sonnet", true, w.writer), { kind: "done", name: "ORCH_SONNET", value: "on", result: { ok: false, results: [] } });
  assert.equal(w.calls.length, 0);
});

test("applySwitchAll: invalid key/value → invalid, zero writes", async () => {
  const w = fakeWriter();
  for (const [k, v] of [["gpt", true], ["codex", "off"], ["window", "25:00-26:00"], ["window", 3], ["__proto__", true], [undefined, true]] as [unknown, unknown][]) {
    const out = await applySwitchAll(REPOS, k, v, w.writer);
    assert.equal(out.kind, "invalid", JSON.stringify([k, v]));
  }
  assert.equal(w.calls.length, 0);
});

test("applySwitchAll: fable writes ORCH_FABLE once per repo in order; value reads back", async () => {
  const w = fakeWriter();
  await applySwitchAll(REPOS, "fable", false, w.writer);
  assert.deepEqual(w.calls, ["o/a ORCH_FABLE=off", "o/b ORCH_FABLE=off", "o/c ORCH_FABLE=off"]);
  assert.equal(switchesFromVars([{ name: "ORCH_FABLE", value: "off" }]).fable, false);
  const w2 = fakeWriter();
  await applySwitchAll(REPOS, "fable", true, w2.writer);
  assert.ok(w2.calls.every((c) => c.endsWith("ORCH_FABLE=on")));
  assert.equal(switchesFromVars([{ name: "ORCH_FABLE", value: "on" }]).fable, true);
});

test("mergedSwitches: fable difference sits after opus and before codex", () => {
  const m = mergedSwitches([view("o/self", ON, true), view("o/b", { ...ON, fable: false, opus: false, codex: false })]);
  assert.deepEqual(m.differs, [{ key: "opus", repos: ["o/b"] }, { key: "fable", repos: ["o/b"] }, { key: "codex", repos: ["o/b"] }]);
});
