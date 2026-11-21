import { test } from "node:test";
import assert from "node:assert/strict";
import * as C from "./core.mjs";
import { decide, parseReview, previousReviews, reviewComment, reviewPrompt, planHash, MAX_ROUNDS } from "./plan-review.mjs";

const plan = { goal: "g", steps: [{ id: 1, title: "t", task: "x", done_when: ["npm test 통과"] }] };
const H = planHash(C.parsePlan("```json\n" + JSON.stringify(plan) + "\n```").plan);
const body = (p = plan) => "설명\n\n```json\n" + JSON.stringify(p) + "\n```";
const BOT = { id: 41898282, type: "Bot", login: "github-actions[bot]" };
const issue = (extra = {}) => ({ number: 7, body: body(), labels: [], ...extra });
const posted = (round, hash, verdict = "REVISE", user = BOT) => ({ user, body: reviewComment({ round, hash, reviewer: "codex", review: { verdict, summary: "s", findings: [{ step: 1, severity: "high", body: "b" }] }, runUrl: "u" }) });

test("decide: first round goes to Codex when on and logged in, else Opus", () => {
  const d = decide({ issue: issue(), comments: [], env: {}, hasCodexKey: true });
  assert.equal(d.skip, false); assert.equal(d.round, 1); assert.equal(d.reviewer, "codex"); assert.equal(d.hash, H);
  assert.equal(decide({ issue: issue(), comments: [], env: { ORCH_CODEX: "off" }, hasCodexKey: true }).reviewer, "claude");
  assert.equal(decide({ issue: issue(), comments: [], env: {}, hasCodexKey: false }).reviewer, "claude");
  assert.match(decide({ issue: issue(), comments: [], env: { ORCH_CODEX: "off", ORCH_OPUS: "off" }, hasCodexKey: true }).reason, /감사할 모델이 없음/);
  assert.match(decide({ issue: issue(), comments: [], env: { ORCH_PAUSED: "on" }, hasCodexKey: true }).reason, /일시정지/);
});

test("decide: stops once approved, when unchanged, after 3 rounds; bad JSON is reported", () => {
  for (const l of ["orch:go", "orch:run", "orch:done"]) assert.equal(decide({ issue: issue({ labels: [{ name: l }] }), comments: [], env: {}, hasCodexKey: true }).skip, true);
  const h = H;
  assert.match(decide({ issue: issue(), comments: [posted(1, h)], env: {}, hasCodexKey: true }).reason, /이미 감사/);
  const d2 = decide({ issue: issue(), comments: [posted(1, "old")], env: {}, hasCodexKey: true });
  assert.equal(d2.round, 2); assert.equal(d2.previous.findings[0].body, "b");
  const full = Array.from({ length: MAX_ROUNDS }, (_, i) => posted(i + 1, `h${i}`));
  assert.match(decide({ issue: issue(), comments: full, env: {}, hasCodexKey: true }).reason, /3라운드/);
  assert.match(decide({ issue: issue({ body: "```json\n{bad\n```" }), comments: [], env: {}, hasCodexKey: true }).reason, /형식 오류/);
});

test("previousReviews: only the Actions bot counts (a person cannot fake a round)", () => {
  const person = { id: 1, type: "User", login: "someone" };
  assert.equal(previousReviews([posted(1, "x", "OK", person)]).length, 0);
  assert.equal(previousReviews([posted(2, "b"), posted(1, "a")])[0].round, 1);
});

test("parseReview: strict shape; REVISE needs a blocking finding; fenced JSON accepted", () => {
  assert.deepEqual(parseReview('{"verdict":"OK","summary":"fine","findings":[]}'), { verdict: "OK", summary: "fine", findings: [] });
  assert.equal(parseReview('{"verdict":"REVISE","summary":"","findings":[{"step":1,"severity":"low","body":"nit"}]}'), null);
  assert.equal(parseReview("You've hit your usage limit."), null);
  assert.equal(parseReview('```json\n{"verdict":"REVISE","summary":"s","findings":[{"step":null,"severity":"high","body":"x"}]}\n```').findings[0].step, null);
});

test("reviewPrompt / comment: Claude path writes a file and may use planner; marker survives '-->' in findings", () => {
  assert.match(reviewPrompt({ plan, round: 1, previous: null, reviewer: "claude" }), /planner[\s\S]*\.orch\/PLAN_REVIEW\.json/);
  assert.doesNotMatch(reviewPrompt({ plan, round: 1, previous: null, reviewer: "codex" }), /PLAN_REVIEW\.json/);
  const c = reviewComment({ round: 1, hash: "h", reviewer: "claude", review: { verdict: "REVISE", summary: "s", findings: [{ step: 1, severity: "high", body: "a --> b" }] }, runUrl: "u" });
  assert.equal(previousReviews([{ user: BOT, body: c }])[0].findings[0].body, "a --> b");
  assert.match(c, /Claude Opus \(Codex 대신\): ✏️ 수정 필요/);
  assert.match(reviewComment({ round: 2, hash: "h", reviewer: "codex", review: null, runUrl: "u", note: "Codex 실행 실패" }), /⚠️ 감사 실패[\s\S]*Codex 실행 실패/);
});
