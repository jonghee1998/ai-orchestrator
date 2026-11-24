import test from "node:test";
import assert from "node:assert/strict";
import { decideRevise, replacePlan, checkRevised, noteComment, revisePrompt, NOTE_MARK } from "./plan-revise.mjs";
import { autoNext, MAX_ROUNDS } from "./plan-review.mjs";

const PLAN = { goal: "목표", steps: [{ id: 1, title: "스텝", task: "do", done_when: ["npm test 통과"] }] };
const body = (p = PLAN) => "계획\n\n```json\n" + JSON.stringify(p) + "\n```\n\n끝";
const BOT = { id: 41898282, login: "github-actions[bot]", type: "Bot" };
const review = (round, verdict, findings = [{ step: 1, severity: "high", body: "고칠 것" }]) => ({
  user: BOT, body: `<!-- orch-plan-review:v1 ${JSON.stringify({ round, hash: `h${round}`, verdict, reviewer: "codex", findings })} -->\n### 감사` });
const issue = (o = {}) => ({ state: "open", title: "[plan] x", labels: [], body: body(), ...o });

test("autoNext: OK → go, REVISE → revise (final on the last round), off / no verdict → none", () => {
  assert.deepEqual(autoNext({ review: { verdict: "OK" }, round: 1, auto: true }), { next: "go", final: false });
  assert.deepEqual(autoNext({ review: { verdict: "REVISE" }, round: 1, auto: true }), { next: "revise", final: false });
  assert.deepEqual(autoNext({ review: { verdict: "REVISE" }, round: MAX_ROUNDS, auto: true }), { next: "revise", final: true });
  assert.deepEqual(autoNext({ review: { verdict: "OK" }, round: 1, auto: false }), { next: "none", final: false });
  assert.deepEqual(autoNext({ review: null, round: 1, auto: true }), { next: "none", final: false });
});

test("decideRevise: needs auto, open [plan], not started, latest REVISE not yet handled", () => {
  const c = [review(1, "REVISE")];
  assert.equal(decideRevise({ issue: issue(), comments: c, auto: false }).skip, true);
  assert.equal(decideRevise({ issue: issue({ labels: [{ name: "orch:run" }] }), comments: c, auto: true }).skip, true);
  assert.equal(decideRevise({ issue: issue({ title: "[idea] x" }), comments: c, auto: true }).skip, true);
  assert.equal(decideRevise({ issue: issue(), comments: [review(1, "OK")], auto: true }).skip, true);
  const d = decideRevise({ issue: issue(), comments: c, auto: true });
  assert.equal(d.skip, false);
  assert.equal(d.final, false);
  assert.equal(d.review.round, 1);
  const handled = [...c, { user: { login: "o" }, body: `${NOTE_MARK} round:1\n...` }];
  assert.equal(decideRevise({ issue: issue(), comments: handled, auto: true }).skip, true, "same round twice is skipped");
  const forged = [{ user: { login: "o", id: 1 }, body: review(3, "REVISE").body }];
  assert.equal(decideRevise({ issue: issue(), comments: forged, auto: true }).skip, true, "only the Actions bot's rounds count");
  const last = [review(1, "REVISE"), review(2, "REVISE"), review(3, "REVISE")];
  assert.equal(decideRevise({ issue: issue(), comments: last, auto: true }).final, true);
});

test("revisePrompt carries the plan, findings and the final-round rule", () => {
  const p = revisePrompt({ plan: PLAN, review: { round: 3, findings: [{ step: 1, severity: "high", body: "고칠 것" }] }, final: true });
  assert.match(p, /"goal": "목표"/);
  assert.match(p, /\[high\] Step 1: 고칠 것/);
  assert.match(p, /마지막 라운드/);
  assert.match(p, /PLAN_REVISED\.json/);
});

test("replacePlan swaps only the first json block; checkRevised keeps the goal and the plan format", () => {
  const next = { ...PLAN, steps: [{ ...PLAN.steps[0], task: "do better" }] };
  const out = replacePlan(body(), next);
  assert.match(out, /^계획\n\n```json\n/);
  assert.match(out, /do better/);
  assert.match(out, /\n```\n\n끝$/);
  assert.equal(replacePlan("no block", next), null);
  assert.equal(checkRevised(JSON.stringify(next), PLAN).ok, true);
  assert.equal(checkRevised("```json\n" + JSON.stringify(next) + "\n```", PLAN).ok, true);
  assert.equal(checkRevised(JSON.stringify({ ...next, goal: "다른 목표" }), PLAN).ok, false);
  assert.equal(checkRevised(JSON.stringify({ goal: "목표", steps: [] }), PLAN).ok, false);
  assert.equal(checkRevised("not json", PLAN).ok, false);
});

test("noteComment: marker with the round, and what happens next", () => {
  assert.match(noteComment({ round: 2, final: false, notes: "1. 반영", changed: true, start: false }), new RegExp(`^${NOTE_MARK} round:2`));
  assert.match(noteComment({ round: 2, final: false, notes: "", changed: true, start: false }), /다음 라운드/);
  assert.match(noteComment({ round: 3, final: true, notes: "", changed: true, start: true }), /바로 시작/);
  assert.match(noteComment({ round: 1, final: false, notes: "", changed: false, start: true }), /그대로 두고 바로 시작/);
  assert.match(noteComment({ round: 1, final: false, notes: "", changed: false, start: false }), /사람이 확인/);
});

test("checkRevised: unreadable model names fall back instead of stopping the plan", async () => {
  const { checkRevised, normalizeModels } = await import("./plan-revise.mjs");
  const old = { goal: "g", steps: [{ id: 1, title: "t", task: "k", done_when: ["d"] }] };
  const out = checkRevised(JSON.stringify({ goal: "g", model: "Opus (DB 변경)", steps: [{ id: 1, title: "t", task: "k", done_when: ["d"], model: null }, { id: 2, title: "t2", task: "k", done_when: ["d"], model: "Claude Sonnet" }] }), old);
  assert.equal(out.ok, true);
  assert.equal(out.plan.model, "opus");
  assert.equal("model" in out.plan.steps[0], false);
  assert.equal(out.plan.steps[1].model, "sonnet");
  assert.equal("model" in normalizeModels({ model: "!!" }), false);
});
