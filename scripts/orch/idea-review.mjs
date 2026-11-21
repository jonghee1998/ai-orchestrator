// 아이디어함: 소유자가 쓴 "[idea] 항목" Issue(본문 = 사용자 의견)에 Claude(PM)와 Codex가 각자 의견을 내고, 종합 의견을 댓글 1개로 남긴다.
// 코드는 바꾸지 않는다(읽기 전용). Codex를 못 쓰면 Claude 의견만으로 종합하고 "Codex 의견 대기"로 표시한다. 본문이 바뀌면 다시 의견을 낸다.
//   node idea-review.mjs prepare  → outputs: skip, reason, hash, codex(true|false), prompt (+ $RUNNER_TEMP/idea-codex-prompt.md, idea-schema.json)
//   node idea-review.mjs publish  → 종합 의견 댓글 1개 (github-actions[bot])
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import * as C from "./core.mjs";
import { client } from "./github.mjs";

const MARK_RE = /<!-- orch-idea:v1 (\{[^<>\n]*\}) -->/;
const ACTIONS_BOT_ID = 41898282;
export const IDEA_PREFIX = "[idea]";

export const ideaHash = (title, body) => crypto.createHash("sha256").update(`${title}\n${body ?? ""}`).digest("hex").slice(0, 16);
export const ideaTitle = (title) => String(title ?? "").replace(/^\[idea\]\s*/i, "").trim();

/** Latest idea review written by the Actions bot (a person cannot fake one). */
export function latestReview(comments) {
  let found = null;
  for (const c of comments ?? []) {
    if (c?.user?.id !== ACTIONS_BOT_ID || c?.user?.type !== "Bot") continue;
    const m = MARK_RE.exec(c.body ?? "");
    if (!m) continue;
    try { found = { ...JSON.parse(m[1]), at: c.created_at ?? null }; } catch { /* ignore */ }
  }
  return found;
}

export function decide({ issue, comments, env, hasCodexKey, force = false }) {
  if (issue.pull_request) return { skip: true, reason: "PR" };
  if (!String(issue.title ?? "").toLowerCase().startsWith(IDEA_PREFIX)) return { skip: true, reason: "아이디어 Issue 아님" };
  if (issue.state !== "open") return { skip: true, reason: "닫힌 아이디어" };
  const hash = ideaHash(issue.title, issue.body);
  const prev = latestReview(comments);
  const sw = C.readSwitches(env);
  const codex = sw.codex && hasCodexKey;
  // Same text already reviewed: only re-run when Codex was missing then and is available now (or forced).
  if (prev?.hash === hash && !force && !(prev.codexPending && codex)) return { skip: true, reason: "이미 의견을 냄 (본문 변경 없음)" };
  if (sw.paused) return { skip: true, reason: "전체 일시정지 중" };
  if (!sw.opus && !sw.sonnet) return { skip: true, reason: "Claude 모델이 모두 OFF" };
  return { skip: false, hash, codex, title: ideaTitle(issue.title), mine: String(issue.body ?? "").slice(0, 6000) };
}

export const OPINION_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["value", "effort", "risk", "steps", "recommend", "reasons"],
  properties: {
    value: { type: "string", enum: ["high", "medium", "low"] },
    effort: { type: "string", enum: ["S", "M", "L"] },
    risk: { type: "string", enum: ["high", "medium", "low"] },
    steps: { type: "integer" },
    recommend: { type: "string", enum: ["now", "later", "hold"] },
    reasons: { type: "string" },
  },
};

const ideaBlock = ({ title, mine }) => [
  `## 아이디어\n**${title}**`,
  `## 사용자 의견 (원문)\n${mine || "(없음)"}`,
  "## 판단 기준",
  "- 저장소(`CLAUDE.md`, `PRODUCT.md`, `docs/ORCH_MANUAL.md`, 관련 코드)를 읽고, 이 시스템(오케스트레이터 + 모바일 상황판)에 실제로 어떻게 붙을지 생각한다.",
  "- value: 사용자에게 주는 가치. effort: S(스텝 1~2) / M(3~5) / L(6+). risk: 보안·데이터·운영 위험. steps: 예상 스텝 수. recommend: now(지금) / later(나중) / hold(보류).",
  "- reasons: 근거 3~5줄. 비슷한 기능이 이미 있으면 그것을 짚는다. 구현 방향을 한두 줄 제안해도 된다.",
  "- 코드나 파일은 바꾸지 않는다.",
];

export function codexPrompt(idea) {
  return ["너는 이 저장소의 리뷰어(Codex)다. 사용자가 적어 둔 아이디어에 대한 의견을 낸다.", ...ideaBlock(idea),
    "## 결과\n최종 응답은 아래 형식의 JSON 하나만 출력한다.",
    '{"value":"high|medium|low","effort":"S|M|L","risk":"high|medium|low","steps":3,"recommend":"now|later|hold","reasons":"..."}'].join("\n\n");
}

export function claudePrompt(idea, codexOpinion) {
  return [
    "너는 이 저장소의 PM(Claude)이다. 사용자가 적어 둔 아이디어에 대해 너의 의견을 내고, Codex 의견이 있으면 둘을 종합한다.",
    ...ideaBlock(idea),
    codexOpinion ? `## Codex 의견\n\`\`\`json\n${JSON.stringify(codexOpinion)}\n\`\`\`` : "## Codex 의견\n(이번에는 없음 — 너의 의견만으로 종합한다)",
    "## 결과 (반드시 작성)",
    "`.orch/IDEA_REVIEW.json`에 아래 JSON만 쓴다. summary는 사용자가 폰에서 읽을 종합 의견 3~5줄(짧고 직접적인 한국어). agree/disagree는 Codex와 같은 점·다른 점 한 줄씩(Codex 의견이 없으면 빈 문자열).",
    '{"claude":{"value":"high|medium|low","effort":"S|M|L","risk":"high|medium|low","steps":3,"recommend":"now|later|hold","reasons":"..."},"summary":{"recommend":"now|later|hold","text":"...","agree":"...","disagree":"..."}}',
  ].join("\n\n");
}

const pick = (v, ok, d) => (ok.includes(v) ? v : d);
const clean = (o) => o && typeof o === "object" ? {
  value: pick(o.value, ["high", "medium", "low"], "medium"),
  effort: pick(o.effort, ["S", "M", "L"], "M"),
  risk: pick(o.risk, ["high", "medium", "low"], "medium"),
  steps: Number.isInteger(o.steps) && o.steps > 0 && o.steps < 30 ? o.steps : null,
  recommend: pick(o.recommend, ["now", "later", "hold"], "later"),
  reasons: String(o.reasons ?? "").slice(0, 1500),
} : null;
const parseJsonText = (t) => { try { return JSON.parse(String(t ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "")); } catch { return null; } };

export const parseOpinion = (text) => { const j = parseJsonText(text); return j && j.reasons ? clean(j) : null; };
export function parseClaude(text) {
  const j = parseJsonText(text);
  if (!j?.claude || !j?.summary?.text) return null;
  return {
    claude: clean(j.claude),
    summary: {
      recommend: pick(j.summary.recommend, ["now", "later", "hold"], "later"),
      text: String(j.summary.text).slice(0, 2000),
      agree: String(j.summary.agree ?? "").slice(0, 500),
      disagree: String(j.summary.disagree ?? "").slice(0, 500),
    },
  };
}

const REC = { now: "지금 하자", later: "나중에", hold: "보류" };
const VAL = { high: "높음", medium: "보통", low: "낮음" };
const line = (who, o) => o ? `| ${who} | ${VAL[o.value]} | ${o.effort}${o.steps ? ` (~${o.steps}스텝)` : ""} | ${VAL[o.risk]} | ${REC[o.recommend]} |` : `| ${who} | - | - | - | 의견 대기 |`;

export function reviewComment({ hash, claude, codex, summary, codexPending, runUrl }) {
  const marker = { hash, recommend: summary?.recommend ?? null, summary: summary?.text ?? null, agree: summary?.agree ?? "", disagree: summary?.disagree ?? "", claude, codex, codexPending: Boolean(codexPending) };
  const json = JSON.stringify(marker).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/\n/g, "\\n");
  return [
    `<!-- orch-idea:v1 ${json} -->`,
    summary ? `### 💡 종합 의견: ${REC[summary.recommend]}` : "### 💡 의견을 만들지 못했습니다",
    "",
    summary?.text ?? "",
    summary?.agree ? `\n- 같은 점: ${summary.agree}` : "",
    summary?.disagree ? `- 다른 점: ${summary.disagree}` : "",
    "",
    "| | 가치 | 규모 | 위험 | 추천 |", "|---|---|---|---|---|",
    line("Claude (PM)", claude), line("Codex", codex),
    codexPending ? "\n_Codex 의견 대기 — Codex를 쓸 수 있게 되면 다시 실행해 채웁니다._" : "",
    claude?.reasons ? `\n<details><summary>Claude 근거</summary>\n\n${claude.reasons}\n</details>` : "",
    codex?.reasons ? `<details><summary>Codex 근거</summary>\n\n${codex.reasons}\n</details>` : "",
    "", `[실행 로그](${runUrl})`,
  ].filter((x) => x !== "").join("\n");
}

// ---------------------------------------------------------------- CLI
const env = process.env;
function setOutput(key, value) {
  const v = String(value ?? "");
  if (!env.GITHUB_OUTPUT) return console.log(`[idea] ${key}=${v.slice(0, 200)}`);
  const delim = `IDEA_${crypto.randomBytes(6).toString("hex")}`;
  fs.appendFileSync(env.GITHUB_OUTPUT, `${key}<<${delim}\n${v}\n${delim}\n`);
}

async function prepare() {
  const gh = client(env.GITHUB_TOKEN, env.GITHUB_REPOSITORY);
  const n = Number(env.ISSUE);
  const issue = await gh.get(`/issues/${n}`);
  const owner = env.GITHUB_REPOSITORY.split("/")[0];
  if (issue.user?.login !== owner) { setOutput("skip", "true"); setOutput("reason", "소유자가 쓴 아이디어만 받음"); return; }
  const comments = await gh.all(`/issues/${n}/comments?per_page=100`);
  const d = decide({ issue, comments, env, hasCodexKey: Boolean(env.CODEX_AUTH_KEY), force: env.FORCE === "true" });
  if (d.skip) { console.log(`[idea] skip #${n}: ${d.reason}`); setOutput("skip", "true"); setOutput("reason", d.reason); return; }
  const tmp = env.RUNNER_TEMP ?? ".";
  fs.writeFileSync(path.join(tmp, "idea-codex-prompt.md"), codexPrompt(d));
  fs.writeFileSync(path.join(tmp, "idea-schema.json"), JSON.stringify(OPINION_SCHEMA));
  fs.writeFileSync(path.join(tmp, "idea.json"), JSON.stringify({ title: d.title, mine: d.mine }));
  for (const [k, v] of Object.entries({ skip: "false", hash: d.hash, codex: d.codex })) setOutput(k, v);
}

/** Between the Codex and Claude steps: build the Claude prompt with Codex's opinion (if any). */
function claudePromptCmd() {
  const tmp = env.RUNNER_TEMP ?? ".";
  const idea = JSON.parse(fs.readFileSync(path.join(tmp, "idea.json"), "utf8"));
  let codex = null;
  try { codex = parseOpinion(fs.readFileSync(path.join(tmp, "codex-idea.json"), "utf8")); } catch { /* none */ }
  setOutput("prompt", claudePrompt(idea, codex));
  setOutput("codex_ok", Boolean(codex));
}

async function publish() {
  const gh = client(env.GITHUB_TOKEN, env.GITHUB_REPOSITORY);
  const read = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
  const codex = parseOpinion(read(path.join(env.RUNNER_TEMP ?? ".", "codex-idea.json")));
  const r = parseClaude(read(".orch/IDEA_REVIEW.json"));
  const body = reviewComment({ hash: env.HASH, claude: r?.claude ?? null, codex, summary: r?.summary ?? null, codexPending: !codex, runUrl: env.RUN_URL });
  await gh.post(`/issues/${env.ISSUE}/comments`, { body });
  console.log(`[idea] #${env.ISSUE} ${r?.summary?.recommend ?? "ERROR"} codex=${Boolean(codex)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = { prepare, "claude-prompt": async () => claudePromptCmd(), publish }[process.argv[2]];
  if (!cmd) { console.error("usage: idea-review.mjs prepare|claude-prompt|publish"); process.exit(2); }
  cmd().catch((e) => { console.error(e); process.exit(1); });
}
