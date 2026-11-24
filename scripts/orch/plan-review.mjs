// claudex 루프 (PM 계획 감사): PM(Claude)이 쓴 계획 Issue를 Codex가 감사하고, PM이 고치면 다시 감사한다. 최대 3라운드.
// Codex를 쓸 수 없으면(OFF·한도·로그인 없음) Claude Opus가 planner·architect 보조 에이전트로 대신 감사한다.
// 사람이 orch:go를 붙이기 전 단계에서만 동작하고, 계획 본문이 바뀌었을 때만 새 라운드를 연다.
//   node plan-review.mjs prepare   → outputs: skip, reason, round, reviewer(codex|claude), hash, prompt (+ $RUNNER_TEMP/plan-review-prompt.md)
//   node plan-review.mjs publish   → 감사 결과 댓글 1개 (작성자 github-actions[bot])
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import * as C from "./core.mjs";
import { client } from "./github.mjs";

export const MAX_ROUNDS = 3;
const MARK_RE = /<!-- orch-plan-review:v1 ([\s\S]*?) -->/;
const ACTIONS_BOT_ID = 41898282;
const STOP_LABELS = ["orch:go", "orch:run", "orch:done", "orch:blocked", "orch:cancel"];

export const planHash = (plan) => crypto.createHash("sha256").update(JSON.stringify(plan)).digest("hex").slice(0, 16);

/** Earlier rounds, oldest first. Only comments by the Actions bot count (a person cannot forge a round). */
export function previousReviews(comments) {
  const out = [];
  for (const c of comments ?? []) {
    if (c?.user?.id !== ACTIONS_BOT_ID || c?.user?.type !== "Bot") continue;
    const m = MARK_RE.exec(c.body ?? "");
    if (!m) continue;
    try {
      const j = JSON.parse(m[1]);
      if (Number.isInteger(j.round) && typeof j.hash === "string") out.push({ round: j.round, hash: j.hash, verdict: j.verdict, reviewer: j.reviewer, findings: Array.isArray(j.findings) ? j.findings : [] });
    } catch { /* ignore */ }
  }
  return out.sort((a, b) => a.round - b.round);
}

/**
 * Decide whether to run a review round now.
 * @returns {{skip:true, reason:string} | {skip:false, round:number, reviewer:"codex"|"claude", hash:string, plan:object, previous:object|null}}
 */
export function decide({ issue, comments, env, hasCodexKey }) {
  const labels = (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l.name));
  const stop = labels.find((l) => STOP_LABELS.includes(l));
  if (stop) return { skip: true, reason: `이미 승인/진행된 계획 (${stop})` };
  if (issue.pull_request) return { skip: true, reason: "PR" };
  const parsed = C.parsePlan(issue.body);
  if (!parsed.ok) return { skip: true, reason: `계획 형식 오류: ${parsed.error}` };
  const hash = planHash(parsed.plan);
  const prev = previousReviews(comments);
  if (prev.at(-1)?.hash === hash) return { skip: true, reason: "이 계획은 이미 감사함 (본문 변경 없음)" };
  if (prev.length >= MAX_ROUNDS) return { skip: true, reason: `감사 ${MAX_ROUNDS}라운드를 모두 사용함` };
  const sw = C.readSwitches(env);
  if (sw.paused) return { skip: true, reason: "전체 일시정지 중" };
  const reviewer = sw.codex && hasCodexKey ? "codex" : sw.opus ? "claude" : null;
  if (!reviewer) return { skip: true, reason: "감사할 모델이 없음 (Codex·Opus 모두 사용 불가)" };
  return { skip: false, round: prev.length + 1, reviewer, hash, plan: parsed.plan, previous: prev.at(-1) ?? null };
}

export const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "findings"],
  properties: {
    verdict: { type: "string", enum: ["OK", "REVISE"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["step", "severity", "body"],
        properties: { step: { type: ["integer", "null"] }, severity: { type: "string", enum: ["high", "medium", "low"] }, body: { type: "string" } },
      },
    },
  },
};

export function reviewPrompt({ plan, round, previous, reviewer }) {
  return [
    "너는 이 저장소의 계획 감사자다. PM(Claude)이 쓴 오케스트레이터 계획을, 구현에 들어가기 전에 감사한다. 저장소 코드는 바꾸지 않는다 (결과 파일 외에는 아무것도 쓰지 않는다).",
    `라운드 ${round}/${MAX_ROUNDS}.`,
    "## 계획 (JSON)",
    "```json\n" + JSON.stringify(plan, (_k, v) => (v === null ? undefined : v), 2) + "\n```",
    previous ? `## 이전 라운드 지적 (PM이 반영했는지 확인)\n${previous.findings.map((f, i) => `${i + 1}. [${f.severity}] ${f.step ? `Step ${f.step}: ` : ""}${f.body}`).join("\n") || "(없음)"}` : "",
    "## 감사 기준",
    "- 저장소 코드(`CLAUDE.md`, `docs/ORCH_MANUAL.md`, 관련 소스)를 직접 읽고 계획이 실제 코드와 맞는지 본다. 없는 파일·함수를 가정하면 지적한다.",
    "- 스텝 분할: 한 스텝이 너무 크거나(파일 다수·성격이 다른 일 혼합) 순서가 틀리면(뒤 스텝이 앞 스텝 결과에 의존하지 않는데 묶임, 또는 그 반대) 지적한다.",
    "- `done_when`이 기계로 확인 가능한지(테스트·명령·grep·화면 문구). '잘 동작함' 같은 모호한 기준은 지적한다.",
    "- 빠진 스텝·테스트·문서, 회귀 위험, 보안(인증·비밀값·권한), 데이터 손실 위험.",
    "- 구현 Claude가 할 수 없는 일(`.github/`·`scripts/orch/` 수정, push·PR 생성)을 스텝에 넣었는지.",
    "- 모델(`model`)·`auto_merge`·`max_retries` 선택이 위험도에 맞는지.",
    "- 취향·문체만으로 REVISE 하지 않는다. high/medium 지적이 하나라도 있으면 REVISE, 아니면 OK.",
    reviewer === "claude"
      ? "## 보조 에이전트\n`.claude/agents/`에 `planner`·`architect`가 있으면 Task 도구로 불러 스텝 분할·설계 위험을 점검하게 할 수 있다(읽기 전용으로 지시). 그 지적은 네가 직접 코드로 확인한 것만 쓴다.\n## 결과 (반드시 작성)\n`.orch/PLAN_REVIEW.json`에 아래 형식의 JSON만 쓴다."
      : "## 결과\n최종 응답은 아래 형식의 JSON 하나만 출력한다.",
    '{"verdict":"OK"|"REVISE","summary":"판정 근거 2~4줄","findings":[{"step":1,"severity":"high"|"medium"|"low","body":"무엇이 왜 문제이고 어떻게 고치면 되는지"}]}',
  ].filter(Boolean).join("\n\n");
}

/** Validate reviewer output. Returns null when unusable (→ fallback / ERROR). */
export function parseReview(text) {
  if (!text) return null;
  const raw = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  let j;
  try { j = JSON.parse(raw); } catch { return null; }
  if (!j || !["OK", "REVISE"].includes(j.verdict)) return null;
  const findings = (Array.isArray(j.findings) ? j.findings : []).slice(0, 20).map((f) => ({
    step: Number.isInteger(f?.step) ? f.step : null,
    severity: ["high", "medium", "low"].includes(f?.severity) ? f.severity : "low",
    body: String(f?.body ?? "").slice(0, 1500),
  })).filter((f) => f.body);
  if (j.verdict === "REVISE" && !findings.some((f) => f.severity !== "low")) return null; // REVISE must say what blocks
  return { verdict: j.verdict, summary: String(j.summary ?? "").slice(0, 2000), findings };
}

export function reviewComment({ round, hash, reviewer, review, runUrl, note = "" }) {
  const who = reviewer === "codex" ? "Codex" : "Claude Opus (Codex 대신)";
  const v = review?.verdict;
  const head = v === "OK" ? "✅ OK — 승인(`orch:go`) 가능" : v === "REVISE" ? "✏️ 수정 필요" : "⚠️ 감사 실패";
  const marker = `<!-- orch-plan-review:v1 ${JSON.stringify({ round, hash, verdict: v ?? "ERROR", reviewer, findings: review?.findings ?? [] }).replace(/-->/g, "--\\u003e")} -->`;
  const list = (review?.findings ?? []).map((f, i) => `${i + 1}. **${f.severity}**${f.step ? ` · Step ${f.step}` : ""} — ${f.body}`);
  return [
    marker,
    `### 계획 감사 ${round}/${MAX_ROUNDS} · ${who}: ${head}`,
    "",
    review?.summary || (review ? "" : `결과를 읽지 못했습니다.${note ? ` (${note})` : ""}`),
    list.length ? `\n${list.join("\n")}` : "",
    "",
    v === "REVISE" ? (round < MAX_ROUNDS ? "_PM이 계획 본문을 고치면 다음 라운드 감사가 자동으로 시작됩니다._" : "_마지막 라운드입니다. PM이 반영 여부를 정리해 사용자에게 보고합니다._") : "",
    `[실행 로그](${runUrl})`,
  ].filter((x) => x !== "").join("\n");
}

// ---------------------------------------------------------------- CLI (GitHub Actions)

const env = process.env;
function setOutput(key, value) {
  const v = String(value ?? "");
  if (!env.GITHUB_OUTPUT) return console.log(`[plan-review] ${key}=${v.slice(0, 200)}`);
  const delim = `PR_${crypto.randomBytes(6).toString("hex")}`;
  fs.appendFileSync(env.GITHUB_OUTPUT, `${key}<<${delim}\n${v}\n${delim}\n`);
}

async function prepare() {
  const gh = client(env.GITHUB_TOKEN, env.GITHUB_REPOSITORY);
  const n = Number(env.ISSUE);
  const issue = await gh.get(`/issues/${n}`);
  const comments = await gh.all(`/issues/${n}/comments?per_page=100`);
  const d = decide({ issue, comments, env, hasCodexKey: Boolean(env.CODEX_AUTH_KEY) });
  if (d.skip) { console.log(`[plan-review] skip #${n}: ${d.reason}`); setOutput("skip", "true"); setOutput("reason", d.reason); return; }
  const prompt = reviewPrompt({ plan: d.plan, round: d.round, previous: d.previous, reviewer: d.reviewer });
  const claudePrompt = reviewPrompt({ plan: d.plan, round: d.round, previous: d.previous, reviewer: "claude" });
  fs.writeFileSync(path.join(env.RUNNER_TEMP ?? ".", "plan-review-prompt.md"), prompt);
  fs.writeFileSync(path.join(env.RUNNER_TEMP ?? ".", "plan-review-schema.json"), JSON.stringify(REVIEW_SCHEMA));
  for (const [k, v] of Object.entries({ skip: "false", round: d.round, reviewer: d.reviewer, hash: d.hash, prompt: claudePrompt })) setOutput(k, v);
}

async function publish() {
  const gh = client(env.GITHUB_TOKEN, env.GITHUB_REPOSITORY);
  const read = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
  const claude = parseReview(read(".orch/PLAN_REVIEW.json"));
  const codex = parseReview(read(path.join(env.RUNNER_TEMP ?? ".", "codex-plan-review.json")));
  const usedClaude = env.CLAUDE_RAN === "true";
  const review = usedClaude ? claude : codex;
  const reviewer = usedClaude ? "claude" : "codex";
  const body = reviewComment({ round: Number(env.ROUND), hash: env.HASH, reviewer, review, runUrl: env.RUN_URL, note: env.NOTE ?? "" });
  await gh.post(`/issues/${env.ISSUE}/comments`, { body });
  console.log(`[plan-review] #${env.ISSUE} round ${env.ROUND} ${reviewer} ${review?.verdict ?? "ERROR"}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = { prepare, publish }[process.argv[2]];
  if (!cmd) { console.error("usage: plan-review.mjs prepare|publish"); process.exit(2); }
  cmd().catch((e) => { console.error(e); process.exit(1); });
}
