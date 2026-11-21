// 가짜 GitHub API 응답 (결과 화면 테스트용). 실제 엔진이 쓰는 Issue 본문 형식(계획 JSON + orch-state 마커)을 그대로 쓴다.
// 토큰·개인정보 없음. 저장소 이름도 가짜(example/orch-screens).
export const REPO = "example/orch-screens";

const plan = (goal, steps = 2) => "```json\n" + JSON.stringify({
  goal,
  steps: Array.from({ length: steps }, (_, i) => ({ id: i + 1, title: `스텝 ${i + 1}`, task: "x", done_when: ["d"] })),
}, null, 2) + "\n```";
const state = (s) => `<!-- orch-state:v1 ${JSON.stringify({ v: 1, ...s })} -->`;
const issue = (number, title, body, extra = {}) => ({ number, title, body, html_url: `https://github.com/${REPO}/issues/${number}`, state: "open", ...extra });

/** @param {Date} now — usage snapshot is "fresh" relative to this, so the dashboard never asks for a refresh. */
export function githubFixtures(now) {
  const iso = (minAgo) => new Date(now.getTime() - minAgo * 60_000).toISOString();
  const runsOpen = [
    issue(11, "[plan] 상황판 시험 작업", `${plan("상황판 시험 작업", 3)}\n${state({ status: "implementing", step: 2, passed: { 1: true }, updatedAt: iso(3) })}`),
    issue(12, "[plan] 승인 대기 시험 작업", `${plan("승인 대기 시험 작업")}\n${state({ status: "awaiting_merge", step: 2, passed: { 1: true, 2: true }, finalPr: 99, updatedAt: iso(10) })}`),
  ];
  const runsDone = [
    issue(10, "[plan] 끝난 시험 작업", `${plan("끝난 시험 작업", 1)}\n${state({ status: "done", step: 1, passed: { 1: true }, finalPr: 98, updatedAt: iso(120) })}`, { state: "closed" }),
  ];
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
      return { status: 200, body: [] };
    }
    if (p === `/repos/${REPO}/actions/variables`) return { status: 200, body: { total_count: variables.length, variables } };
    if (p === `/repos/${REPO}/actions/workflows/usage.yml/runs`) return { status: 200, body: { workflow_runs: [{ created_at: iso(5) }] } };
    return null;
  };
}
