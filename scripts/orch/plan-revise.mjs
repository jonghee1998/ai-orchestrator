// Auto mode: PM(Claude) applies the latest plan-audit findings to the plan Issue, without a person.
//   node plan-revise.mjs prepare  → outputs: skip, reason, prompt   (plan-revise.yml, before Claude)
//   node plan-revise.mjs publish  → replaces the plan JSON in the Issue body (owner PAT, so the edit opens the
//                                   next audit round), posts what was done, and on the final round adds orch:go.
// Claude writes .orch/PLAN_REVISED.json (the whole revised plan) and .orch/PLAN_REVISE_NOTES.md (finding → change).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as C from "./core.mjs";
import { client } from "./github.mjs";
import { previousReviews, MAX_ROUNDS } from "./plan-review.mjs";

export const NOTE_MARK = "<!-- orch:pm-auto -->";
const STOP_LABELS = ["orch:go", "orch:run", "orch:done", "orch:blocked", "orch:cancel"];
const PLAN_BLOCK_RE = /```json[^\n]*\n[\s\S]*?```/;

/** Should we revise now? Needs auto mode, an open [plan] issue not yet started, and a REVISE as the latest round. */
export function decideRevise({ issue, comments, auto }) {
  if (!auto) return { skip: true, reason: "자동 모드 꺼짐" };
  if (issue.state !== "open" || issue.pull_request) return { skip: true, reason: "열린 계획 Issue 아님" };
  if (!String(issue.title ?? "").startsWith("[plan]")) return { skip: true, reason: "[plan] Issue 아님" };
  const labels = (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l.name));
  const stop = labels.find((l) => STOP_LABELS.includes(l));
  if (stop) return { skip: true, reason: `이미 시작됨 (${stop})` };
  const parsed = C.parsePlan(issue.body);
  if (!parsed.ok) return { skip: true, reason: `계획 형식 오류: ${parsed.error}` };
  const last = previousReviews(comments).at(-1);
  if (!last || last.verdict !== "REVISE") return { skip: true, reason: "최근 감사가 수정 필요가 아님" };
  const done = comments.some((c) => (c.body ?? "").startsWith(NOTE_MARK) && (c.body ?? "").includes(`round:${last.round}`));
  if (done) return { skip: true, reason: `감사 ${last.round}라운드 지적은 이미 반영함` };
  return { skip: false, plan: parsed.plan, review: last, final: last.round >= MAX_ROUNDS };
}

export function revisePrompt({ plan, review, final }) {
  return [
    "너는 이 저장소의 PM(Claude)이다. 자동 모드라 사람 없이 계획 감사 지적을 반영해 계획을 고친다. 저장소 코드는 바꾸지 않는다(.orch/ 결과 파일 두 개만 쓴다).",
    `감사 ${review.round}/${MAX_ROUNDS}라운드 결과: 수정 필요.${final ? " 마지막 라운드라 고친 뒤 다시 감사하지 않고 바로 시작된다. 그러니 지적을 빠짐없이, 실제 코드로 확인해서 반영한다." : " 고치면 다음 라운드 감사가 자동으로 돈다."}`,
    "## 지금 계획 (JSON)",
    "```json\n" + JSON.stringify(plan, null, 2) + "\n```",
    "## 감사 지적",
    review.findings.map((f, i) => `${i + 1}. [${f.severity}] ${f.step ? `Step ${f.step}: ` : ""}${f.body}`).join("\n") || "(없음)",
    "## 규칙",
    "- 지적마다 저장소 코드(`CLAUDE.md`, `docs/ORCH_MANUAL.md`, `docs/PM_HANDOFF.md`의 '계획 작성 체크리스트', 관련 소스·테스트)를 직접 읽고 확인한 뒤 반영한다. 파일·함수·줄 번호는 실제로 열어 본 것만 쓴다.",
    "- 목표(goal)와 범위는 바꾸지 않는다. 지적이 범위를 넓히라고 하면, 필요한 최소만 넣거나 범위 밖이라고 노트에 적는다.",
    "- 지적에 동의하지 않으면 바꾸지 않아도 되지만, 코드 근거를 노트에 적는다.",
    "- `.github/`·`scripts/orch/` 수정, push·PR 생성을 스텝에 넣지 않는다(구현 Claude가 할 수 없음).",
    "- 계획 형식: goal, steps(최대 10개, 각 id·title·task·done_when, 선택 stop_if·model), 선택 phase·context·max_retries(0~3)·auto_merge·try. 기존 필드는 유지한다.",
    "## 결과 (둘 다 반드시 작성)",
    "1. `.orch/PLAN_REVISED.json`: 고친 계획 JSON 전체(코드 블록 없이 JSON만).",
    "2. `.orch/PLAN_REVISE_NOTES.md`: 지적 번호마다 한 줄씩 '반영: 무엇을 어떻게' 또는 '반영 안 함: 근거'. 쉬운 한국어로.",
  ].join("\n\n");
}

/** Replace the first ```json block of the Issue body with the revised plan. Returns null if the body has no block. */
export function replacePlan(body, plan) {
  if (!PLAN_BLOCK_RE.test(body ?? "")) return null;
  const block = "```json\n" + JSON.stringify(plan, null, 2) + "\n```";
  return body.replace(PLAN_BLOCK_RE, () => block);
}

/** A model the engine cannot read ("Opus", "claude opus", null) falls back to automatic choice instead of stopping the plan. */
export function normalizeModels(plan) {
  const fix = (o) => {
    if (!o || typeof o !== "object" || !("model" in o)) return;
    const m = typeof o.model === "string" ? o.model.trim().toLowerCase().replace(/^claude[\s-]+/, "").split(/[\s(]/)[0] : "";
    if (/^[a-z0-9][a-z0-9.\-]{0,63}$/.test(m)) o.model = m;
    else delete o.model;
  };
  fix(plan);
  for (const s of Array.isArray(plan?.steps) ? plan.steps : []) fix(s);
  return plan;
}

/** Validate Claude's output against the old plan. */
export function checkRevised(text, oldPlan) {
  let raw;
  try { raw = JSON.parse(String(text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "")); } catch (e) { return { ok: false, error: `JSON 파싱 실패: ${e.message}` }; }
  normalizeModels(raw);
  const v = C.validatePlan(raw);
  if (!v.ok) return v;
  if (v.plan.goal !== oldPlan.goal) return { ok: false, error: "목표(goal)가 바뀜" };
  return { ok: true, plan: raw };
}

export function noteComment({ round, final, notes, changed, start }) {
  return [
    `${NOTE_MARK} round:${round}`,
    `### 🤖 PM 자동 반영 (감사 ${round}/${MAX_ROUNDS} 지적)`,
    "",
    String(notes ?? "").trim().slice(0, 6000) || "(노트 없음)",
    "",
    start ? (changed ? "_마지막 라운드라 다시 감사하지 않고 바로 시작합니다(`orch:go`)._" : "_고칠 것이 없다고 판단해 계획을 그대로 두고 바로 시작합니다(`orch:go`)._")
      : changed ? "_계획을 고쳤습니다. 다음 라운드 감사가 자동으로 시작됩니다._"
      : "_고친 계획을 쓰지 못해 멈췄습니다. 사람이 확인해야 합니다._",
  ].join("\n");
}

// ---------------------------------------------------------------- CLI

const env = process.env;

function setOutput(key, value) {
  const v = String(value ?? "");
  if (!env.GITHUB_OUTPUT) return console.log(`[plan-revise] ${key}=${v.slice(0, 200)}`);
  const delim = `PV_${Math.random().toString(36).slice(2)}`;
  fs.appendFileSync(env.GITHUB_OUTPUT, `${key}<<${delim}\n${v}\n${delim}\n`);
}

async function load() {
  const gh = client(env.BOT_PAT, env.GITHUB_REPOSITORY);
  const n = Number(env.ISSUE);
  const issue = await gh.get(`/issues/${n}`);
  const comments = await gh.all(`/issues/${n}/comments?per_page=100`);
  return { gh, n, issue, comments, d: decideRevise({ issue, comments, auto: C.readSwitches(env).auto }) };
}

async function prepare() {
  const { n, d } = await load();
  if (d.skip) { console.log(`[plan-revise] skip #${n}: ${d.reason}`); setOutput("skip", "true"); return; }
  const prompt = revisePrompt(d);
  fs.writeFileSync(path.join(env.RUNNER_TEMP ?? ".", "plan-revise-prompt.md"), prompt);   // Codex fallback
  setOutput("skip", "false");
  setOutput("prompt", prompt);
}

async function publish() {
  const { gh, n, issue, d } = await load();
  if (d.skip) return console.log(`[plan-revise] skip #${n} at publish: ${d.reason}`);
  const read = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
  const notes = read(".orch/PLAN_REVISE_NOTES.md");
  const r = checkRevised(read(".orch/PLAN_REVISED.json"), d.plan);
  let changed = false;
  if (r.ok && JSON.stringify(r.plan) !== JSON.stringify(d.plan)) {
    const body = replacePlan(issue.body, r.plan);
    if (body) { await gh.patch(`/issues/${n}`, { body }); changed = true; }   // owner PAT → issues.edited → next audit round
  }
  // Start now: last round (no more audits), or PM decided nothing needs changing. A broken result before the
  // last round stops here for a person.
  const start = d.final || (r.ok && !changed);
  const extra = r.ok ? "" : `\n\n⚠️ 고친 계획을 쓰지 못했습니다: ${r.error}`;
  await gh.post(`/issues/${n}/comments`, { body: noteComment({ round: d.review.round, final: d.final, notes: notes + extra, changed, start }) });
  if (start) await gh.post(`/issues/${n}/labels`, { labels: [C.LABELS.go] });   // owner label → the engine starts
  console.log(`[plan-revise] #${n} round ${d.review.round} changed=${changed} final=${d.final}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = { prepare, publish }[process.argv[2]];
  if (!cmd) { console.error("usage: plan-revise.mjs prepare|publish"); process.exit(2); }
  cmd().catch((e) => { console.error(e); process.exit(1); });
}
