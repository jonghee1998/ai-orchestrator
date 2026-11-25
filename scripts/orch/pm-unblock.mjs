// Auto mode: when a run stops (status blocked), Codex acts as PM right away instead of waiting for the hourly
// Claude PM check (which cannot run while Claude is usage-limited).
//   node pm-unblock.mjs prepare  → outputs: skip, reason; writes $RUNNER_TEMP/pm-unblock-prompt.md (context + task)
//   node pm-unblock.mjs publish  → reads .orch/PM_DECISION.json and either appends "[PM 지시]" notes to the plan's
//                                  steps and resumes (orch:go, owner PAT), or leaves a "사람 판단 필요" comment.
// Codex never edits code, .github/ or scripts/orch/ here: its only lever is a note appended to a step's task.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as C from "./core.mjs";
import { client } from "./github.mjs";
import { replacePlan } from "./plan-revise.mjs";

export const RESUME_MARK = "<!-- orch:pm-resume -->";
export const HUMAN_MARK = "<!-- orch:pm -->";
export const MAX_AUTO_RESUMES = 3;

/** Should Codex try to unblock this run now? */
export function decideUnblock({ issue, comments, auto, codex }) {
  if (!auto) return { skip: true, reason: "자동 모드 꺼짐" };
  if (!codex) return { skip: true, reason: "Codex 꺼짐" };
  const st = C.readState(issue.body);
  if (!st || st.status !== "blocked") return { skip: true, reason: `중단 상태가 아님 (${st?.status ?? "-"})` };
  if (st.blockKind === "final") return { skip: true, reason: "최종 PR 문제는 사람이 판단" };
  const parsed = C.parsePlan(issue.body);
  if (!parsed.ok) return { skip: true, reason: `계획 형식 오류: ${parsed.error}` };
  const autoResumes = comments.filter((c) => (c.body ?? "").startsWith(RESUME_MARK) && (c.body ?? "").includes("Codex PM 자동 재개")).length;
  if (autoResumes >= MAX_AUTO_RESUMES) return { skip: true, reason: `Codex PM 이 이 run 을 이미 ${autoResumes}번 재개함 — 사람 판단` };
  const blockedAt = st.updatedAt ?? "";
  if (comments.some((c) => (c.body ?? "").includes(`pm-unblock:${blockedAt}`))) return { skip: true, reason: "이번 중단은 이미 처리함" };
  return { skip: false, state: st, plan: parsed.plan, blockedAt };
}

export function unblockPrompt({ repo, plan, state, logs, review }) {
  return [
    `너는 ${repo} 의 PM 이다. 자동 모드 run 이 멈췄다. 사람 없이 원인을 찾아 다시 돌게 하는 것이 일이다.`,
    "저장소 코드는 고치지 않는다. 결과 파일 하나만 쓴다: `.orch/PM_DECISION.json`.",
    "## 멈춘 상태",
    `- Step ${state.step} · 사유: ${C.oneLine(state.reason ?? "", 1500)}`,
    "## 최근 run 기록 (Issue 댓글)", logs || "(없음)",
    "## 스텝 PR 리뷰 지적", review || "(없음)",
    "## 계획 JSON", JSON.stringify(plan, null, 2).slice(0, 20000),
    "## 판단 방법",
    "- docs/PM_HANDOFF.md 와 docs/ORCH_MANUAL.md 가 있으면 읽는다. 지적·사유에 나온 파일을 실제로 열어 원인을 확인한다.",
    "- 같은 지적이 반복되거나 지시끼리 충돌하면: 구현 AI 가 다음 시도에서 피할 수 있게 해당 스텝 task 끝에 붙일 짧은 지시를 쓴다(무엇을 하고 무엇을 하지 말지, 근거 파일·줄).",
    "- 완료 기준이 실제로 불가능하면: 그 기준을 어떻게 바꿔야 하는지 지시로 쓴다(기준 자체는 PM 지시로 대신한다).",
    "- 구현 AI 가 할 수 없는 일(파일 반입, 비밀값, 외부 콘솔, .github/·scripts/orch/ 수정, 허용 안 된 명령)이 필요하면 action 을 human 으로 한다.",
    "- 계획 목표를 바꾸거나 스텝을 지우지 않는다. 실데이터·운영 주소를 쓰지 않는다.",
    "## 결과 (반드시 작성)",
    '`.orch/PM_DECISION.json`: {"action":"resume"|"human","cause":"원인 2~3줄","notes":[{"step":2,"text":"[PM 지시] ..."}]}',
    "- resume 이면 notes 가 1개 이상이어야 한다(멈춘 스텝 또는 그 뒤 스텝). human 이면 cause 에 사람이 할 일을 쉬운 말로 쓴다.",
  ].join("\n\n");
}

/** Apply the decision to the plan. Returns {ok, plan, error}. Notes are appended to existing steps only. */
export function applyDecision(plan, raw) {
  let d;
  try { d = JSON.parse(String(raw ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "")); } catch (e) { return { ok: false, error: `결정 파일 파싱 실패: ${e.message}` }; }
  if (!d || !["resume", "human"].includes(d.action)) return { ok: false, error: "action 은 resume 또는 human" };
  const cause = C.oneLine(String(d.cause ?? ""), 1200);
  if (d.action === "human") return { ok: true, action: "human", cause, plan };
  const notes = Array.isArray(d.notes) ? d.notes : [];
  const next = JSON.parse(JSON.stringify(plan));
  let applied = 0;
  for (const n of notes) {
    const step = next.steps.find((s) => s.id === Number(n?.step));
    const text = C.oneLine(String(n?.text ?? ""), 1500);
    if (!step || !text) continue;
    const t = text.startsWith("[PM 지시") ? text : `[PM 지시] ${text}`;
    if (!step.task.includes(t)) { step.task = `${step.task} ${t}`; applied++; }
  }
  if (!applied) return { ok: false, error: "적용할 지시가 없음" };
  const v = C.validatePlan(next);
  if (!v.ok) return { ok: false, error: v.error };
  return { ok: true, action: "resume", cause, plan: next, applied };
}

// ---------------------------------------------------------------- CLI

const env = process.env;

function setOutput(key, value) {
  const v = String(value ?? "");
  if (!env.GITHUB_OUTPUT) return console.log(`[pm-unblock] ${key}=${v.slice(0, 200)}`);
  const delim = `PU_${Math.random().toString(36).slice(2)}`;
  fs.appendFileSync(env.GITHUB_OUTPUT, `${key}<<${delim}\n${v}\n${delim}\n`);
}

async function load() {
  const gh = client(env.BOT_PAT, env.GITHUB_REPOSITORY);
  const n = Number(env.ISSUE);
  const issue = await gh.get(`/issues/${n}`);
  const comments = await gh.all(`/issues/${n}/comments?per_page=100`);
  const sw = C.readSwitches(env);
  return { gh, n, issue, comments, d: decideUnblock({ issue, comments, auto: sw.auto, codex: sw.codex }) };
}

async function prepare() {
  const { gh, n, comments, d } = await load();
  if (d.skip) { console.log(`[pm-unblock] skip #${n}: ${d.reason}`); setOutput("skip", "true"); return; }
  const logs = comments.filter((c) => /<!-- orch:/.test(c.body ?? "")).slice(-8).map((c) => `- ${C.oneLine(c.body.replace(/<!--[^>]*-->/g, ""), 600)}`).join("\n");
  let review = "";
  const prNum = d.state.pr;
  if (prNum) {
    const inline = await gh.all(`/pulls/${prNum}/comments?per_page=100`).catch(() => []);
    const issueComments = await gh.all(`/issues/${prNum}/comments?per_page=100`).catch(() => []);
    review = [...inline.map((c) => `- ${c.path}:${c.line ?? c.original_line ?? ""} ${C.oneLine(c.body, 700)}`),
      ...issueComments.filter((c) => /claude-review|REVIEW|FAIL/.test(c.body ?? "")).map((c) => `- ${C.oneLine(c.body, 700)}`)].slice(-10).join("\n");
  }
  fs.writeFileSync(path.join(env.RUNNER_TEMP ?? ".", "pm-unblock-prompt.md"), unblockPrompt({ repo: env.GITHUB_REPOSITORY, plan: d.plan, state: d.state, logs, review }));
  setOutput("skip", "false");
}

async function publish() {
  const { gh, n, issue, d } = await load();
  if (d.skip) return console.log(`[pm-unblock] skip #${n} at publish: ${d.reason}`);
  let raw = "";
  try { raw = fs.readFileSync(".orch/PM_DECISION.json", "utf8"); } catch { /* none */ }
  const r = raw ? applyDecision(d.plan, raw) : { ok: false, error: "Codex 가 결정 파일을 쓰지 못함(한도·오류)" };
  const tag = `<!-- pm-unblock:${d.blockedAt} -->`;
  if (r.ok && r.action === "resume") {
    const body = replacePlan(issue.body, r.plan);
    if (body) await gh.patch(`/issues/${n}`, { body });
    await gh.post(`/issues/${n}/comments`, { body: `${RESUME_MARK}\n${tag}\n### 🤖 Codex PM 자동 재개\n${r.cause}\n\n계획에 [PM 지시] ${r.applied}건을 붙이고 재개합니다.` });
    await gh.post(`/issues/${n}/labels`, { labels: [C.LABELS.go] });
    return console.log(`[pm-unblock] #${n} resumed with ${r.applied} note(s)`);
  }
  const why = r.ok ? r.cause : `자동으로 풀지 못함: ${r.error}`;
  await gh.post(`/issues/${n}/comments`, { body: `${HUMAN_MARK}\n${tag}\n### 🤖 Codex PM 점검 — 사람 판단 필요\n${why}` });
  console.log(`[pm-unblock] #${n} needs a person: ${why}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = { prepare, publish }[process.argv[2]];
  if (!cmd) { console.error("usage: pm-unblock.mjs prepare|publish"); process.exit(2); }
  cmd().catch((e) => { console.error(e); process.exit(1); });
}
