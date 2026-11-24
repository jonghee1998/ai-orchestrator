import test from "node:test";
import assert from "node:assert/strict";
import { gate, parseNextPlan, humanBody, readNextState, codexPrompt, claudePrompt, PLAN_MARK, DEFAULT_DAILY_CAP } from "./plan-next.mjs";

const NOW = Date.parse("2026-11-25T03:00:00Z");   // 12:00 KST
const iss = (n, o = {}) => ({ number: n, state: "open", title: "x", labels: [], body: "", created_at: "2026-11-20T00:00:00Z", ...o });
const lab = (...names) => names.map((name) => ({ name }));
const PLAN = { goal: "목표", phase: "7", steps: [{ id: 1, title: "s", task: "t", done_when: ["npm test 통과"] }] };
const planMd = (title = "[plan] 7단계: 정리") => `${title}\n\n설명\n\n\`\`\`json\n${JSON.stringify(PLAN)}\n\`\`\``;

test("gate: only in auto mode, with nothing open, below the daily cap", () => {
  const base = { auto: true, issues: [], human: null, mainSha: "a", nowMs: NOW };
  assert.equal(gate(base).skip, false);
  assert.match(gate({ ...base, auto: false }).reason, /자동 모드/);
  assert.match(gate({ ...base, issues: [iss(1, { title: "[plan] 대기" })] }).reason, /열린 계획/);
  assert.equal(gate({ ...base, issues: [iss(1, { title: "[plan] 끝", state: "closed" })] }).skip, false, "closed plan is fine");
  assert.match(gate({ ...base, issues: [iss(2, { labels: lab("orch:run") })] }).reason, /진행 중/);
  assert.match(gate({ ...base, issues: [iss(3, { labels: lab("orch:blocked") })] }).reason, /중단된 run/);
  assert.equal(gate({ ...base, issues: [iss(4, { pull_request: {}, labels: lab("orch:run") })] }).skip, false, "PRs ignored");
  const today = Array.from({ length: DEFAULT_DAILY_CAP }, (_, i) => iss(10 + i, { state: "closed", body: `${PLAN_MARK}\n…`, created_at: "2026-11-25T01:00:00Z" }));
  assert.match(gate({ ...base, issues: today }).reason, /하루 상한/);
  const yesterday = today.map((i) => ({ ...i, created_at: "2026-11-24T10:00:00Z" }));   // 19:00 KST the day before
  assert.equal(gate({ ...base, issues: yesterday }).skip, false);
});

test("gate: after 'nothing to do' wait for main to change; after a failure wait an hour", () => {
  const base = { auto: true, issues: [], mainSha: "a", nowMs: NOW };
  const human = (st) => ({ body: `## 사람 할 일\n\n<!-- orch-next:v1 ${JSON.stringify(st)} -->` });
  assert.match(gate({ ...base, human: human({ none: true, mainSha: "a" }) }).reason, /main 이 바뀌지 않음/);
  assert.equal(gate({ ...base, human: human({ none: true, mainSha: "b" }) }).skip, false);
  assert.match(gate({ ...base, human: human({ none: false, mainSha: "a", failAt: "2026-11-25T02:30:00Z" }) }).reason, /1시간/);
  assert.equal(gate({ ...base, human: human({ none: false, mainSha: "a", failAt: "2026-11-25T01:30:00Z" }) }).skip, false);
});

test("parseNextPlan: '[plan] …' title line + body with a valid plan block", () => {
  const p = parseNextPlan(planMd());
  assert.equal(p.ok, true);
  assert.equal(p.title, "[plan] 7단계: 정리");
  assert.match(p.body, /"phase":"7"/, "phase stays in the body (the dashboard reads it from the raw plan)");
  assert.match(p.body, /^설명/);
  assert.equal(parseNextPlan("").ok, false);
  assert.equal(parseNextPlan(planMd("7단계")).ok, false, "title must start with [plan]");
  assert.equal(parseNextPlan("[plan] x\n\nno json").ok, false);
  assert.equal(parseNextPlan(`[plan] ${"긴".repeat(130)}\n\n\`\`\`json\n${JSON.stringify(PLAN)}\n\`\`\``).ok, false);
});

test("humanBody: header once, dedupe, keep checked items, state marker replaced", () => {
  const b1 = humanBody("", { todos: ["- Vercel 연결 바꾸기 (링크)", "- 운영 DB 마이그레이션"], state: { none: false, mainSha: "a" } });
  assert.match(b1, /^## 사람 할 일/);
  assert.match(b1, /- \[ \] Vercel 연결 바꾸기 \(링크\)/);
  assert.deepEqual(readNextState(b1), { none: false, mainSha: "a" });
  const checked = b1.replace("- [ ] 운영 DB 마이그레이션", "- [x] 운영 DB 마이그레이션");
  const b2 = humanBody(checked, { todos: ["- 운영 DB 마이그레이션", "- 새 일"], state: { none: true, mainSha: "b" } });
  assert.equal(b2.match(/## 사람 할 일/g).length, 1);
  assert.equal(b2.match(/운영 DB 마이그레이션/g).length, 1, "no duplicate");
  assert.match(b2, /- \[x\] 운영 DB 마이그레이션/, "checked item kept");
  assert.match(b2, /- \[ \] 새 일/);
  assert.equal(b2.match(/orch-next:v1/g).length, 1);
  assert.deepEqual(readNextState(b2), { none: true, mainSha: "b" });
});

test("prompts: Codex is read-only fact finding; Claude gets the facts, the human-work rule and the output files", () => {
  const c = codexPrompt({ repo: "o/r" });
  assert.match(c, /읽기 전용/);
  assert.match(c, /사람이 해야 하는 일/);
  assert.match(c, /단계 통합 검수/);
  const p = claudePrompt({ repo: "o/r", facts: "## 사실\n- a.ts:10" });
  assert.match(p, /a\.ts:10/);
  assert.match(p, /끝났다고 가정/);
  assert.match(p, /통합 검수에 빠진 것/);
  assert.match(p, /NEXT_PLAN\.md/);
  assert.match(p, /NEXT_NONE\.md/);
  assert.match(p, /HUMAN_TODO\.md/);
  assert.match(claudePrompt({ repo: "o/r", facts: "" }), /Codex 를 쓰지 못함/);
});

test("workflows: codex exec uses only flags the current CLI accepts (--full-auto was removed)", async () => {
  const fs = await import("node:fs");
  for (const f of ["claude-work.yml", "plan-next.yml", "plan-revise.yml", "plan-review.yml"]) {
    const y = fs.readFileSync(new URL(`../../.github/workflows/${f}`, import.meta.url), "utf8");
    assert.doesNotMatch(y, /--full-auto/, f);
    for (const m of y.matchAll(/codex exec ([^\n]*)/g)) assert.match(m[1], /-s (read-only|workspace-write)/, `${f}: ${m[1]}`);
  }
});
