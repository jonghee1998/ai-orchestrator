// 가짜 GitHub API 응답 (결과 화면 테스트용). 실제 엔진이 쓰는 Issue 본문 형식(계획 JSON + orch-state 마커)을 그대로 쓴다.
// 토큰·개인정보 없음. 저장소 이름도 가짜(example/orch-screens).
import { parsePlan } from "../orch/core.mjs";
import { planHash } from "../orch/plan-review.mjs";
import { ideaHash } from "../orch/idea-review.mjs";

export const REPO = "example/orch-screens";
const OWNER = { login: "example" }; // REPO owner — the engine and the dashboard only accept owner-authored plans
const ACTIONS_BOT = { login: "github-actions[bot]", id: 41898282, type: "Bot" };

// tag: 스텝 제목·할 일 문구를 화면의 다른 문구와 겹치지 않게 만드는 고유 접두어.
const plan = (goal, steps = 2, tag = "베타") => "```json\n" + JSON.stringify({
  goal,
  steps: Array.from({ length: steps }, (_, i) => ({ id: i + 1, title: `${tag}공정 ${i + 1}단계 제목`, task: "x", done_when: [`${tag}공정 ${i + 1}단계 확인항목`] })),
}, null, 2) + "\n```";
const state = (s) => `<!-- orch-state:v1 ${JSON.stringify({ v: 1, ...s })} -->`;
const issue = (number, title, body, extra = {}) => ({ number, title, body, html_url: `https://github.com/${REPO}/issues/${number}`, state: "open", user: OWNER, ...extra });

/** @param {Date} now — usage snapshot is "fresh" relative to this, so the dashboard never asks for a refresh. */
export function githubFixtures(now) {
  const iso = (minAgo) => new Date(now.getTime() - minAgo * 60_000).toISOString();
  const runsOpen = [
    issue(11, "[plan] 상황판 시험 작업", `${plan("상황판 시험 작업", 3, "알파")}\n${state({ status: "implementing", step: 2, passed: { 1: true }, updatedAt: iso(3) })}`),
    issue(12, "[plan] 승인 대기 시험 작업", `${plan("승인 대기 시험 작업")}\n${state({ status: "awaiting_merge", step: 2, passed: { 1: true, 2: true }, finalPr: 99, updatedAt: iso(10) })}`),
  ];
  const runsDone = [
    issue(10, "[plan] 끝난 시험 작업", `${plan("끝난 시험 작업", 1, "감마")}\n${state({ status: "done", step: 1, passed: { 1: true }, finalPr: 98, updatedAt: iso(120) })}`, { state: "closed" }),
  ];
  // 승인 대기 계획: 라벨 없음 + 소유자 작성 + 감사 OK 2/3 (마커 hash = 실제 planHash → stale 아님)
  const pendingBody = plan("승인 기다리는 시험 계획", 2, "델타");
  const pending = issue(13, "[plan] 승인 기다리는 시험 계획", pendingBody, { labels: [] });
  const parsed = parsePlan(pendingBody);
  if (!parsed.ok) throw new Error(`fixture plan invalid: ${parsed.error}`);
  const review = { round: 2, hash: planHash(parsed.plan), verdict: "OK", reviewer: "codex", findings: [] };
  const comments = {
    13: [{ id: 1301, user: ACTIONS_BOT, created_at: iso(20), body: `### ✅ 계획 감사 2/3 · OK\n\n<!-- orch-plan-review:v1 ${JSON.stringify(review)} -->` }],
  };
  // 라벨 없이 조회(state=open, per_page=30)하면 실행 중 Issue(orch:run)도 함께 온다 — 화면은 승인 대기 계획만 골라야 함
  const openUnlabeled = [pending, ...runsOpen.map((i) => ({ ...i, labels: [{ name: "orch:run" }] }))];

  // 아이디어함: 소유자가 쓴 '[idea]' Issue(라벨 없음). 의견 완료 1개(Actions 봇 마커, 실제 hash) + 수집 중 1개(댓글 없음).
  const ideaDone = issue(21, "[idea] 상황판 채팅", "폰에서 바로 물어보고 싶음", { created_at: iso(90) });
  const op = (recommend, steps) => ({ value: "high", effort: "M", risk: "low", steps, recommend, reasons: "자주 쓰는 흐름이라 효과가 큼" });
  const ideaMarker = { hash: ideaHash(ideaDone.title, ideaDone.body), recommend: "now", summary: "묻고 답하는 흐름을 먼저 붙이면 효과가 큽니다", agree: "폰에서 쓰는 가치가 큼", disagree: "규모 추정이 다름", claude: op("now", 3), codex: op("later", 4), codexPending: false };
  const ideaJson = JSON.stringify(ideaMarker).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/\n/g, "\\n");
  comments[21] = [{ id: 2101, user: ACTIONS_BOT, created_at: iso(80), body: `### 💡 종합 의견: 지금 하자\n\n<!-- orch-idea:v1 ${ideaJson} -->` }];
  const ideaCollecting = issue(22, "[idea] 알림 모아보기", "중요한 알림만 한곳에서 보고 싶음", { created_at: iso(5) });
  const allIssues = [ideaCollecting, ideaDone, ...runsOpen, ...runsDone, pending]; // state=all, 라벨 없음 (readIdeas)

  const usage = {
    v: 1, updatedAt: iso(5), claudeCheckedAt: iso(5), claudeError: null,
    claude: { status: "allowed", fiveHour: { pct: 42, resetsAt: iso(-120) }, sevenDay: { pct: 30, resetsAt: iso(-3000) } },
    codex: { limited: false, lastReviewAt: iso(30), needsLogin: false, quotaCheckedAt: iso(5), quotaError: null,
      quota: { allowed: true, fiveHour: { pct: 10, resetsAt: iso(-200) }, weekly: { pct: 55, resetsAt: iso(-5000) } } },
  };
  const usageIssue = issue(5, "AI 사용량", `엔진이 갱신하는 AI 사용량입니다.\n\n<!-- orch-usage:v1 ${JSON.stringify(usage)} -->`);
  const variables = [{ name: "ORCH_CODEX", value: "off" }, { name: "ORCH_PAUSED", value: "off" }];

  /** @returns {{status:number, body:unknown} | null} */
  return (method, url) => {
    if (method !== "GET") return null; // the screens test is read-only; writes are reported as problems
    const p = url.pathname, q = url.searchParams;
    if (p === `/repos/${REPO}/issues`) {
      const label = q.get("labels");
      if (label === "orch:run") return { status: 200, body: runsOpen };
      if (label === "orch:done") return { status: 200, body: runsDone };
      if (label === "orch:usage") return { status: 200, body: [usageIssue] };
      if (label === null && q.get("state") === "open" && q.get("per_page") === "30") return { status: 200, body: openUnlabeled };
      if (label === null && q.get("state") === "all") return { status: 200, body: allIssues };
      return { status: 200, body: [] };
    }
    const cm = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/.exec(p);
    if (cm && p.startsWith(`/repos/${REPO}/`)) return { status: 200, body: comments[cm[1]] ?? [] };
    if (p === `/repos/${REPO}/actions/variables`) return { status: 200, body: { total_count: variables.length, variables } };
    if (p === `/repos/${REPO}/actions/workflows/usage.yml/runs`) return { status: 200, body: { workflow_runs: [{ created_at: iso(5) }] } };
    return null;
  };
}
