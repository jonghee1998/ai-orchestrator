import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, latestReview, reviewComment, parseOpinion, parseClaude, ideaHash, ideaTitle, claudePrompt } from "./idea-review.mjs";

const BOT = { id: 41898282, type: "Bot", login: "github-actions[bot]" };
const issue = (extra = {}) => ({ number: 3, title: "[idea] 상황판 채팅", body: "폰에서 바로 물어보고 싶음", state: "open", ...extra });
const op = { value: "high", effort: "M", risk: "low", steps: 3, recommend: "now", reasons: "r" };
const posted = (hash, extra = {}) => ({ user: BOT, created_at: "2026-11-21T10:00:00Z", body: reviewComment({ hash, claude: op, codex: null, summary: { recommend: "now", text: "좋음", agree: "", disagree: "" }, codexPending: true, runUrl: "u", ...extra }) });

test("decide: idea issues only, once per text; re-run when Codex was pending and is available now", () => {
  const h = ideaHash(issue().title, issue().body);
  const d = decide({ issue: issue(), comments: [], env: {}, hasCodexKey: true });
  assert.equal(d.skip, false); assert.equal(d.codex, true); assert.equal(d.title, "상황판 채팅"); assert.equal(d.hash, h);
  assert.equal(decide({ issue: issue(), comments: [], env: { ORCH_CODEX: "off" }, hasCodexKey: true }).codex, false);
  assert.match(decide({ issue: issue({ title: "버그" }), comments: [], env: {}, hasCodexKey: true }).reason, /아이디어 Issue 아님/);
  assert.match(decide({ issue: issue({ state: "closed" }), comments: [], env: {}, hasCodexKey: true }).reason, /닫힌/);
  assert.match(decide({ issue: issue(), comments: [posted(h)], env: { ORCH_CODEX: "off" }, hasCodexKey: true }).reason, /이미 의견/);
  assert.equal(decide({ issue: issue(), comments: [posted(h)], env: {}, hasCodexKey: true }).skip, false, "codex now available → fill it in");
  assert.equal(decide({ issue: issue(), comments: [posted(h, { codexPending: false, codex: op })], env: {}, hasCodexKey: true }).skip, true);
  assert.equal(decide({ issue: issue({ body: "바뀜" }), comments: [posted(h)], env: { ORCH_CODEX: "off" }, hasCodexKey: true }).skip, false, "text changed");
  assert.match(decide({ issue: issue(), comments: [], env: { ORCH_PAUSED: "on" }, hasCodexKey: true }).reason, /일시정지/);
});

test("latestReview: only the Actions bot counts; marker survives newlines and '-->'", () => {
  const c = posted("h", { summary: { recommend: "later", text: "a\nb --> c", agree: "x", disagree: "y" } });
  const r = latestReview([c]);
  assert.equal(r.summary, "a\nb --> c"); assert.equal(r.recommend, "later"); assert.equal(r.at, "2026-11-21T10:00:00Z");
  assert.equal(latestReview([{ ...c, user: { id: 1, type: "User" } }]), null);
  assert.match(c.body, /종합 의견: 나중에/);
  assert.match(c.body, /\| Codex \| - \| - \| - \| 의견 대기 \|/);
});

test("parsers: strict shapes, safe defaults", () => {
  assert.deepEqual(parseOpinion(JSON.stringify(op)), op);
  assert.equal(parseOpinion("You've hit your usage limit"), null);
  assert.equal(parseOpinion('{"value":"high"}'), null, "needs reasons");
  assert.equal(parseOpinion(JSON.stringify({ ...op, value: "huge", steps: 99 })).value, "medium");
  const c = parseClaude(JSON.stringify({ claude: op, summary: { recommend: "now", text: "t" } }));
  assert.equal(c.summary.agree, ""); assert.equal(c.claude.recommend, "now");
  assert.equal(parseClaude('{"claude":{}}'), null);
  assert.equal(ideaTitle("[IDEA]  제목 "), "제목");
  assert.match(claudePrompt({ title: "t", mine: "m" }, op), /## Codex 의견\n```json/);
  assert.match(claudePrompt({ title: "t", mine: "m" }, null), /이번에는 없음/);
});
