import assert from "node:assert/strict";
import test from "node:test";
import { activeAgents, pickModel, resolveModel } from "./agents";
import type { OrchRun, OrchStatus, RunStep, Switches } from "./model";

const sw = (o: Partial<Switches> = {}): Switches => ({ sonnet: true, opus: true, codex: true, paused: false, window: "", ...o });
const step = (id: number, o: Partial<RunStep> = {}): RunStep => ({ id, title: `스텝 ${id}`, state: "current", checks: [], model: null, task: null, ...o });
function run(o: Partial<OrchRun> = {}): OrchRun {
  return {
    repo: "o/a", number: 1, url: "u1", goal: "g", status: "implementing", statusLabel: "", step: 1, total: 1, passed: 0, steps: [step(1)],
    pr: null, finalPr: null, retries: 0, maxRetries: 3, planModel: null, held: null, reason: null, updatedAt: null, needsUser: false, next: "", ...o,
  };
}
const row = (rows: ReturnType<typeof activeAgents>, a: string) => rows.find((r) => r.agent === a)!;

// ---- engine parity: compare the copy against scripts/orch/core.mjs
type Core = {
  pickModel: (plan: unknown, id: number, retries: number) => { model: string; why: string };
  resolveModel: (pick: { model: string; why: string }, sw: Switches) => { model: string } | { hold: string };
};
async function core(): Promise<Core> {
  const { pathToFileURL } = await import("node:url");
  const path = await import("node:path");
  return (new Function("p", "return import(p)") as (p: string) => Promise<Core>)(pathToFileURL(path.resolve("scripts/orch/core.mjs")).href);
}
const kind = (m: string | null) => (m === null ? "hold" : /opus/i.test(m) ? "opus" : "sonnet");

type PStep = { id: number; title?: string; task?: string; model?: string };

test("pickModel/resolveModel match scripts/orch/core.mjs", async () => {
  const eng = await core();
  const cases: { plan: { model?: string; steps: PStep[] }; retries: number }[] = [];
  const add = (steps: PStep[], model?: string, retries = 0) => cases.push({ plan: { ...(model ? { model } : {}), steps }, retries });
  add([{ id: 1, title: "버튼 색 변경", task: "색만 바꾼다" }]); // plain
  add([{ id: 1, title: "버튼", task: "로그인 세션 수정" }]); // risky in task
  add([{ id: 1, title: "DB 마이그레이션", task: "x" }]); // risky in title only
  add([{ id: 1, title: "t", task: "x", model: "opus" }]); // step
  add([{ id: 1, title: "t", task: "x", model: "sonnet" }], "opus"); // step beats plan
  add([{ id: 1, title: "t", task: "x" }], "opus"); // plan
  add([{ id: 1, title: "t", task: "x" }], "sonnet");
  add([{ id: 1, title: "t", task: "x", model: "claude-opus-4-5" }]); // full model id
  add([{ id: 1, title: "t", task: "x", model: "claude-sonnet-4-5" }]);
  add([{ id: 1, title: "t", task: "x", model: "claude-haiku-4-5" }], undefined, 2);
  add([{ id: 1, title: "t", task: "x" }], undefined, 2); // escalate
  add([{ id: 1, title: "t", task: "x" }], undefined, 1); // not yet
  add([{ id: 1, title: "t", task: "x", model: "opus" }], undefined, 5);
  add([{ id: 1, title: "t" }]); // no task
  add([{ id: 1, title: "인증 정리" }], "sonnet", 3); // plan sonnet + retries
  const switchSets = [sw(), sw({ sonnet: false }), sw({ opus: false }), sw({ sonnet: false, opus: false })];
  for (const { plan, retries } of cases) {
    for (const s of switchSets) {
      const e = eng.pickModel(plan, 1, retries);
      const er = eng.resolveModel(e, s);
      const r = run({
        planModel: plan.model ?? null,
        retries,
        steps: plan.steps.map((p) => step(p.id, { title: p.title ?? "", task: p.task ?? null, model: p.model ?? null })),
      });
      const mine = pickModel(r, 1, retries);
      const ctx = JSON.stringify({ plan, retries, s });
      assert.equal(mine, e.model, ctx);
      assert.equal(kind(resolveModel(mine, s)), "hold" in er ? "hold" : kind(er.model), ctx);
    }
  }
});

// ---- assignment by status
test("status → agent assignment", () => {
  const mk = (status: OrchStatus, n: number) => run({ status, number: n, url: `u${n}` });
  const rows = activeAgents(
    [mk("implementing", 1), mk("fixing", 2), mk("reviewing", 3), mk("awaiting_merge", 4), mk("blocked", 5), mk("finalizing", 6), mk("waiting", 7), mk("done", 8), mk("cancelled", 9)],
    { "o/a": sw() },
  );
  assert.deepEqual(rows.map((r) => r.agent), ["sonnet", "opus", "codex", "user"]);
  assert.deepEqual(row(rows, "sonnet").items.map((i) => [i.number, i.activity]), [[1, "구현 중"], [2, "수정 중"]]);
  assert.deepEqual(row(rows, "codex").items.map((i) => [i.number, i.activity]), [[3, "검수 중"]]);
  assert.deepEqual(row(rows, "user").items.map((i) => [i.number, i.activity]), [[4, "반영 승인 대기"], [5, "멈춤 확인 필요"]]);
  assert.deepEqual(row(rows, "opus").items, []);
});

test("risky text / retries / switches move implementing to opus", () => {
  const risky = run({ steps: [step(1, { title: "로그인 수정" })] });
  assert.equal(row(activeAgents([risky], { "o/a": sw() }), "opus").items.length, 1);
  assert.equal(row(activeAgents([run({ retries: 2 })], { "o/a": sw() }), "opus").items.length, 1);
  assert.equal(row(activeAgents([run()], { "o/a": sw({ sonnet: false }) }), "opus").items.length, 1);
  assert.equal(row(activeAgents([run()], { "o/a": sw({ sonnet: false, opus: false }) }), "sonnet").items.length, 0);
});

test("reviewing: codex off → opus; both off → nobody", () => {
  const r = run({ status: "reviewing" });
  assert.equal(row(activeAgents([r], { "o/a": sw({ codex: false }) }), "opus").items[0].activity, "검수 중");
  assert.ok(activeAgents([r], { "o/a": sw({ codex: false, opus: false }) }).every((x) => x.items.length === 0));
});

test("multiple repos mix per their own switches; item fields", () => {
  const a = run({ repo: "o/a", number: 1, goal: "ga", step: 2, total: 4, steps: [step(2)] });
  const b = run({ repo: "o/b", number: 2, url: "u2" });
  const rows = activeAgents([a, b], { "o/a": sw(), "o/b": sw({ sonnet: false }) });
  assert.deepEqual(row(rows, "sonnet").items, [{ repo: "o/a", number: 1, url: "u1", goal: "ga", step: 2, total: 4, activity: "구현 중" }]);
  assert.deepEqual(row(rows, "opus").items.map((i) => i.repo), ["o/b"]);
});

test("empty input: four idle rows", () => {
  const rows = activeAgents([], {});
  assert.deepEqual(rows.map((r) => [r.agent, r.items.length, r.off]), [["sonnet", 0, false], ["opus", 0, false], ["codex", 0, false], ["user", 0, false]]);
});

// ---- switches
test("null switches → engine defaults (all on)", () => {
  const rows = activeAgents([run(), run({ status: "reviewing", number: 2 })], { "o/a": null });
  assert.equal(row(rows, "sonnet").items.length, 1);
  assert.equal(row(rows, "codex").items.length, 1);
  assert.ok(rows.every((r) => !r.off));
  assert.equal(row(activeAgents([run()], {}), "sonnet").items.length, 1); // repo missing from map
});

test("off: true only when OFF in every repo with switches", () => {
  const some = activeAgents([], { "o/a": sw({ opus: false }), "o/b": sw() });
  assert.equal(row(some, "opus").off, false);
  const all = activeAgents([], { "o/a": sw({ opus: false, codex: false }), "o/b": sw({ opus: false }) });
  assert.equal(row(all, "opus").off, true);
  assert.equal(row(all, "codex").off, false);
  assert.equal(row(all, "sonnet").off, false);
  assert.equal(row(all, "user").off, false);
  const withNull = activeAgents([], { "o/a": sw({ opus: false }), "o/b": null });
  assert.equal(row(withNull, "opus").off, true); // unread repo is ignored
});

test("held runs are excluded", () => {
  const rows = activeAgents([run({ held: "Sonnet·Opus가 모두 OFF" }), run({ status: "reviewing", held: "x", number: 2 })], { "o/a": sw() });
  assert.ok(rows.every((r) => r.items.length === 0));
});
