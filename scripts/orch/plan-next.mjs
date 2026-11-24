// Auto mode: write the next plan without a person, so the project keeps moving after a run finishes.
//   node plan-next.mjs prepare  → outputs: skip, reason, codex_prompt, claude_prompt (+ files in $RUNNER_TEMP)
//   node plan-next.mjs publish  → opens the "[plan] …" Issue as the owner (plan-review → auto start follows),
//                                 or records "nothing to do" and the human to-do list in the orch:human Issue.
// Flow inside plan-next.yml: Codex (read-only) writes a fact sheet about the current phase's remaining work and the
// code it touches → Claude (Opus) picks the next piece of work and writes the plan, using the fact sheet.
// Guards: auto mode only; nothing open ([plan] Issue or orch:run); not after a blocked/cancelled run; a daily cap;
// after "nothing to do" it does not run again until main changes.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as C from "./core.mjs";
import { client } from "./github.mjs";

export const HUMAN_LABEL = "orch:human";
export const NEXT_MARK_RE = /<!-- orch-next:v1 (\{[^\n]*?\}) -->/;
export const PLAN_MARK = "<!-- orch:auto-plan -->";
export const DEFAULT_DAILY_CAP = 8;

const kstDay = (ms) => new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10);

/**
 * Should plan-next run now?
 * @param issues   open + recently closed issues (REST /issues objects; PRs are ignored)
 * @param human    the orch:human Issue or null
 * @param mainSha  current main HEAD
 */
export function gate({ auto, issues, human, mainSha, nowMs = Date.now(), dailyCap = DEFAULT_DAILY_CAP }) {
  if (!auto) return { skip: true, reason: "자동 모드 꺼짐" };
  const real = issues.filter((i) => !i.pull_request);
  const labels = (i) => (i.labels ?? []).map((l) => (typeof l === "string" ? l : l.name));
  const openPlan = real.find((i) => i.state === "open" && String(i.title ?? "").startsWith("[plan]"));
  if (openPlan) return { skip: true, reason: `열린 계획이 있음 (#${openPlan.number})` };
  const running = real.find((i) => i.state === "open" && labels(i).includes(C.LABELS.run));
  if (running) return { skip: true, reason: `진행 중인 run 이 있음 (#${running.number})` };
  const blocked = real.find((i) => i.state === "open" && labels(i).includes(C.LABELS.blocked));
  if (blocked) return { skip: true, reason: `중단된 run 이 있음 (#${blocked.number}) — 사람 판단 대기` };
  const today = kstDay(nowMs);
  const made = real.filter((i) => (i.body ?? "").includes(PLAN_MARK) && i.created_at && kstDay(Date.parse(i.created_at)) === today).length;
  if (made >= dailyCap) return { skip: true, reason: `오늘 자동 계획 ${made}개로 하루 상한(${dailyCap})에 닿음` };
  const st = readNextState(human?.body);
  if (st?.none && st.mainSha === mainSha) return { skip: true, reason: "지난번에 할 일 없음으로 끝났고 그 뒤 main 이 바뀌지 않음" };
  if (st?.failAt && nowMs - Date.parse(st.failAt) < 60 * 60 * 1000) return { skip: true, reason: "1시간 안에 계획 작성이 실패함 — 잠시 뒤 다시" };
  return { skip: false };
}

export function readNextState(body) {
  const m = NEXT_MARK_RE.exec(body ?? "");
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

const CONTEXT_FILES = "`docs/roadmap.json`(진행 단계·상태), `docs/PM_HANDOFF.md`(현재 상태·결정·다음 할 일·계획 작성 체크리스트), `docs/DIAGNOSIS.md`·`docs/ORCH_MANUAL.md`·`CLAUDE.md`(있으면), 최근 닫힌 `[plan]` Issue 와 머지된 PR";

export function codexPrompt({ repo }) {
  return [
    `너는 ${repo} 저장소의 분석가다. 코드는 바꾸지 않는다(읽기 전용). PM(Claude)이 다음 계획을 쓰기 전에 사실을 정리해 준다.`,
    `## 읽을 것\n${CONTEXT_FILES}, 그리고 관련 소스·테스트.`,
    "## 정리할 것 (마크다운, 3000자 안팎)",
    "1. 지금 진행 중인 단계(roadmap.json phases 중 done 이 아닌 첫 단계)와, 그 단계에서 아직 안 끝난 일 목록(완료 근거가 된 PR·파일을 함께).",
    "2. 다음에 할 만한 일 1~3개 후보: 각각 관련 파일·함수·줄 번호, 기존 테스트 파일과 바뀔 기대값, 재사용할 수 있는 기존 코드, 영향 범위, 위험(DB·인증·배포·외부 서비스).",
    "3. 사람이 해야 하는 일(운영 배포, 비밀값·환경변수 설정, 외부 콘솔 작업, 사용자 확인)이 섞여 있으면 따로 표시.",
    "4. 그 단계의 AI 몫이 모두 끝났다고 보이면 단계 통합 검수를 한다: 단계 목표(roadmap.json 의 note, DIAGNOSIS 등 관련 문서의 해당 절)·매뉴얼·실제 코드·테스트가 서로 맞는지 보고, 빠진 것·어긋난 것을 목록으로 쓴다. 빠진 것이 없을 때만 '단계 완료로 보임'과 근거를 쓴다.",
    "추측은 '추측'이라고 쓰고, 파일·줄 번호는 실제로 열어 본 것만 쓴다.",
  ].join("\n\n");
}

export function claudePrompt({ repo, facts }) {
  return [
    `너는 ${repo} 의 PM(Claude)이다. 자동 모드라 사람 없이 다음 계획을 쓴다. 저장소 코드는 바꾸지 않는다(.orch/ 결과 파일만 쓴다).`,
    `## 읽을 것\n${CONTEXT_FILES}. 아래 Codex 사전 분석을 참고하되, 계획에 쓰는 파일·함수·줄 번호는 직접 열어 확인한다.`,
    "## Codex 사전 분석",
    facts?.trim() ? facts.trim().slice(0, 12000) : "(없음 — Codex 를 쓰지 못함. 직접 분석한다)",
    "## 고르는 규칙",
    "- roadmap.json 에서 done 이 아닌 첫 단계를 이어 간다. PM_HANDOFF.md 의 결정(예: 미룬 일)을 따른다.",
    "- Codex 통합 검수에 빠진 것·어긋난 것이 있으면 단계를 넘기기 전에 그것부터 계획한다.",
    "- 그 단계의 AI 몫이 다 끝났으면: 다음 계획의 첫 스텝에 'docs/roadmap.json 의 그 단계 status 를 done, 다음 단계를 doing 으로' 를 넣고 다음 단계 일을 이어서 계획한다.",
    "- 사람만 할 수 있는 일(운영 배포, 비밀값·환경변수, 외부 콘솔, 사용자 확인)은 계획에 넣지 않는다. 그 일이 끝났다고 가정하고 AI 가 할 수 있는 코드·테스트·문서를 계획한다. 사람 일은 .orch/HUMAN_TODO.md 에 적는다.",
    "- 한 계획은 스텝 2~4개. 서로 관련 없는 작은 일은 한 스텝으로 묶어 스텝 수를 줄인다. 데이터 계층과 화면은 나눈다.",
    "- docs/PM_HANDOFF.md 의 '계획 작성 체크리스트'를 지킨다(실제 코드 확인, 기존 테스트 충돌, 기계로 확인할 수 있는 done_when, 실패·경계 경우, 보호 경로, 보안·공개 저장소).",
    "- 계획 JSON 최상위에 \"phase\": \"<단계 id>\" 를 넣는다. .github/·scripts/orch/ 수정은 넣지 않는다.",
    "- 모든 단계가 done 이거나, 남은 일이 사람만 할 수 있는 일뿐이면 계획을 쓰지 않는다.",
    "## 결과 (해당하는 것만 쓴다)",
    "1. 계획을 쓸 때: `.orch/NEXT_PLAN.md` — 첫 줄은 Issue 제목(`[plan] ` 로 시작), 빈 줄 뒤 본문(한두 문단 설명 + ```json 계획 블록 하나).",
    "2. 계획을 쓰지 않을 때: `.orch/NEXT_NONE.md` — 이유 한두 줄.",
    "3. 사람 할 일이 있으면: `.orch/HUMAN_TODO.md` — 한 줄에 하나, '- ' 로 시작, 무엇을 어디서(링크) 하는지 쉬운 말로.",
  ].join("\n\n");
}

/** Parse Claude's NEXT_PLAN.md → {title, body, plan} or an error. */
export function parseNextPlan(text) {
  const s = String(text ?? "").replace(/\r\n/g, "\n").trim();
  if (!s) return { ok: false, error: "비어 있음" };
  const nl = s.indexOf("\n");
  const title = (nl < 0 ? s : s.slice(0, nl)).trim();
  if (!/^\[plan\] \S/.test(title) || title.length > 120) return { ok: false, error: "제목이 '[plan] …' 형식이 아님" };
  const body = nl < 0 ? "" : s.slice(nl + 1).trim();
  const p = C.parsePlan(body);
  if (!p.ok) return { ok: false, error: p.error };
  return { ok: true, title, body, plan: p.plan };
}

/** Merge new human to-do lines into the orch:human Issue body (dedupe, keep done ones), and set the state marker. */
export function humanBody(prevBody, { todos = [], state }) {
  const lines = String(prevBody ?? "").replace(NEXT_MARK_RE, "").split("\n");
  const have = new Set(lines.map((l) => l.replace(/^- \[[ x]\] /, "").trim()).filter(Boolean));
  const head = lines.some((l) => l.startsWith("## 사람 할 일")) ? [] : ["## 사람 할 일", "", "자동 모드가 건너뛴, 사람만 할 수 있는 일입니다. 끝나면 체크하세요. 대화를 시작하면 PM 이 이 목록부터 같이 봅니다.", ""];
  const add = todos.map((t) => t.replace(/^-\s*(\[[ x]\]\s*)?/, "").trim()).filter((t) => t && !have.has(t)).map((t) => `- [ ] ${t}`);
  const out = [...head, ...lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")), ...add].join("\n").trim();
  return `${out}\n\n<!-- orch-next:v1 ${JSON.stringify(state)} -->`;
}

// ---------------------------------------------------------------- CLI

const env = process.env;

function setOutput(key, value) {
  const v = String(value ?? "");
  if (!env.GITHUB_OUTPUT) return console.log(`[plan-next] ${key}=${v.slice(0, 200)}`);
  const delim = `PN_${Math.random().toString(36).slice(2)}`;
  fs.appendFileSync(env.GITHUB_OUTPUT, `${key}<<${delim}\n${v}\n${delim}\n`);
}

async function context() {
  const gh = client(env.BOT_PAT, env.GITHUB_REPOSITORY);
  const issues = await gh.get("/issues?state=all&sort=created&direction=desc&per_page=100");
  const human = (await gh.all(`/issues?labels=${encodeURIComponent(HUMAN_LABEL)}&state=open`)).find((i) => !i.pull_request) ?? null;
  const main = await gh.get("/git/ref/heads/main");
  return { gh, issues, human, mainSha: main.object.sha };
}

async function prepare() {
  const { issues, human, mainSha } = await context();
  const g = gate({ auto: C.readSwitches(env).auto, issues, human, mainSha, dailyCap: Number(env.ORCH_DAILY_PLANS) || DEFAULT_DAILY_CAP });
  if (g.skip) { console.log(`[plan-next] skip: ${g.reason}`); setOutput("skip", "true"); setOutput("reason", g.reason); return; }
  const repo = env.GITHUB_REPOSITORY;
  fs.writeFileSync(path.join(env.RUNNER_TEMP ?? ".", "plan-next-codex.md"), codexPrompt({ repo }));
  setOutput("skip", "false");
}

async function claude() {
  const read = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
  const facts = read(path.join(env.RUNNER_TEMP ?? ".", "codex-facts.md"));
  const prompt = claudePrompt({ repo: env.GITHUB_REPOSITORY, facts });
  fs.writeFileSync(path.join(env.RUNNER_TEMP ?? ".", "plan-next-pm.md"), prompt);   // Codex fallback uses the same prompt
  setOutput("prompt", prompt);
}

async function publish() {
  const { gh, issues, human, mainSha } = await context();
  const g = gate({ auto: C.readSwitches(env).auto, issues, human, mainSha, dailyCap: Number(env.ORCH_DAILY_PLANS) || DEFAULT_DAILY_CAP });
  if (g.skip) return console.log(`[plan-next] skip at publish: ${g.reason}`);
  const read = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
  const todos = read(".orch/HUMAN_TODO.md").split("\n").filter((l) => /^\s*-\s+\S/.test(l));
  const next = parseNextPlan(read(".orch/NEXT_PLAN.md"));
  const none = read(".orch/NEXT_NONE.md").trim();
  const now = new Date().toISOString();

  let state, title, note;
  if (!next.ok && !none) {
    // Claude wrote nothing usable (usage limit, error, bad format): no plan, retry after a cool-down.
    state = { none: false, at: now, mainSha, failAt: now, reason: next.error.slice(0, 300) };
    note = `🤖 자동 모드: 다음 계획 작성 실패 — ${state.reason} (1시간 뒤 다시 시도)`;
  } else if (next.ok) {
    const body = `${PLAN_MARK}\n${next.body}\n\n---\n_🤖 자동 모드: PM(Claude)이 다음 계획을 썼습니다(Codex 사전 분석 참고). 감사를 통과하면 자동으로 시작합니다._`;
    const issue = await gh.post("/issues", { title: next.title, body });   // owner PAT → plan-review runs (owner-authored)
    state = { none: false, at: now, mainSha, plan: issue.number };
    note = `🤖 다음 계획 #${issue.number}: ${next.title}`;
    title = next.title;
  } else {
    state = { none: true, at: now, mainSha, reason: (none || next.error).slice(0, 300) };
    note = `🤖 자동 모드: 다음 계획 없음 — ${state.reason}`;
  }
  // Human to-do + state marker live in one open orch:human Issue.
  if (human) {
    await gh.patch(`/issues/${human.number}`, { body: humanBody(human.body, { todos, state }) });
  } else {
    try { await gh.post("/labels", { name: HUMAN_LABEL, color: "fbca04", description: "자동 모드가 건너뛴 사람 할 일" }); } catch (e) { if (e.status !== 422) throw e; }
    await gh.post("/issues", { title: "사람 할 일 (자동 모드)", body: humanBody("", { todos, state }), labels: [HUMAN_LABEL] });
  }
  if (state.none || todos.length) await notify(next.ok ? `🟡 사람 할 일 ${todos.length}개 추가` : "🟡 자동 모드: 다음 계획 없음", next.ok ? title : state.reason);
  console.log(`[plan-next] ${note}`);
}

async function notify(title, message) {
  if (!env.NTFY_TOPIC) return;
  try {
    await fetch("https://ntfy.sh", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: env.NTFY_TOPIC, title, message: C.oneLine(message, 900) }) });
  } catch { /* best effort */ }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = { prepare, claude, publish }[process.argv[2]];
  if (!cmd) { console.error("usage: plan-next.mjs prepare|claude|publish"); process.exit(2); }
  cmd().catch((e) => { console.error(e); process.exit(1); });
}
