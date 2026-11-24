// 가짜 GitHub API 응답 (결과 화면 테스트용). 실제 엔진이 쓰는 Issue 본문 형식(계획 JSON + orch-state 마커)을 그대로 쓴다.
// 토큰·개인정보 없음. 저장소 이름도 가짜(example/orch-screens).
import { parsePlan } from "../orch/core.mjs";
import { planHash } from "../orch/plan-review.mjs";
import { ideaHash } from "../orch/idea-review.mjs";

export const REPO = "example/orch-screens";
export const REPO2 = "example/orch-second"; // 두 번째 가짜 저장소: 여러 저장소에 걸친 '지금 일하는 AI' 예시용
const OWNER = { login: "example" }; // REPO owner — the engine and the dashboard only accept owner-authored plans
const ACTIONS_BOT = { login: "github-actions[bot]", id: 41898282, type: "Bot" };

// tag: 스텝 제목·할 일 문구를 화면의 다른 문구와 겹치지 않게 만드는 고유 접두어.
const plan = (goal, steps = 2, tag = "베타", phase = undefined) => "```json\n" + JSON.stringify({
  goal,
  ...(phase ? { phase } : {}),
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
    // 끝난 작업 #10·#9: 프로젝트 탭에는 나오지 않는다(끝난 일은 패치노트 탭). 남은 할 일·4칸 셈에서도 빠진다.
    issue(10, "[plan] 끝난 시험 작업", `${plan("끝난 시험 작업", 1, "감마")}\n${state({ status: "done", step: 1, passed: { 1: true }, finalPr: 98, updatedAt: iso(120) })}`, { state: "closed" }),
    issue(9, "[plan] 배포된 시험 작업", `${plan("배포된 시험 작업", 1, "엡실론")}\n${state({ status: "done", step: 1, passed: { 1: true }, finalPr: 97, updatedAt: iso(60 * 26) })}`, { state: "closed" }),
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

  // 로드맵(docs/roadmap.json, contents API base64): 인프라 3개 + 확장 2개
  const roadmap = {
    version: 1,
    setup: [
      { id: "0.1", title: "로드맵시험 저장소", status: "done", note: "시험용 메모 · 아주 긴 설명이 들어가도 한 줄로 말줄임되어야 하는 메모 문구입니다" },
      { id: "0.2", title: "로드맵시험 배포", status: "doing", note: null },
      { id: "0.3", title: "로드맵시험 알림", status: "todo", note: null },
    ],
    expansion: [
      { id: "6.1", title: "확장시험 두번째 저장소", status: "todo", note: null },
      { id: "6.2", title: "확장시험 팀 공유", status: "na", note: "필요 없음" },
    ],
    // 자기 저장소(ORCH_SELF_REPO)라 app 이 있어도 '화면 열기' 링크가 없어야 함
    app: { label: "자기화면", url: "https://example.com/self" },
  };
  const roadmapContent = { type: "file", encoding: "base64", content: Buffer.from(JSON.stringify(roadmap, null, 2)).toString("base64") };
  // compare prod-deployed...main: 머지 커밋(parents 2개) 3개 + 일반 커밋 1개 → 카드 머리 '배포 대기 3' (머지 커밋만 셈).
  const sha = (n) => `${n}`.padStart(40, "0");
  const compare = { status: "ahead", commits: [
    { sha: sha(1), parents: [{ sha: sha(90) }], commit: { message: "docs: 메모 정리" } },
    { sha: sha(2), parents: [{ sha: sha(1) }, { sha: sha(91) }], commit: { message: "Merge pull request #98 from example/orch/run-10\n\n끝난 시험 작업" } },
    { sha: sha(3), parents: [{ sha: sha(2) }, { sha: sha(92) }], commit: { message: "Merge pull request #95 from example/topic-a" } },
    { sha: sha(4), parents: [{ sha: sha(3) }, { sha: sha(93) }], commit: { message: "Merge pull request #96 from example/topic-b" } },
  ] };

  const second = secondRepoFixtures(iso, usage);
  /** @returns {{status:number, body:unknown} | null} */
  return (method, url) => {
    if (url.pathname.startsWith(`/repos/${REPO2}/`)) return second(method, url);
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
    if (p === `/repos/${REPO}/contents/docs/roadmap.json`) return { status: 200, body: roadmapContent };
    if (p === `/repos/${REPO}/compare/prod-deployed...main`) return { status: 200, body: compare };
    if (p === `/repos/${REPO}/actions/workflows/usage.yml/runs`) return { status: 200, body: { workflow_runs: [{ created_at: iso(5) }] } };
    return null;
  };
}

// 두 번째 저장소(example/orch-second): 구현 중(Sonnet) #31 · 검수 중(Codex 켜짐) #32 · 승인 대기(사용자) #33. Opus는 쉬는 중.
// 끝난 #30 (orch:done 에만) + roadmap phases 4개 → 카드 머리 '단계 2/4 완료'.
function secondRepoFixtures(iso, usage) {
  const mk = (number, title, body) => ({ number, title, body, html_url: `https://github.com/${REPO2}/issues/${number}`, state: "open", user: OWNER });
  const runs = [
    mk(31, "[plan] 둘째저장소 구현 작업", `${plan("둘째저장소 구현 작업", 2, "시그마")}\n${state({ status: "implementing", step: 1, passed: {}, updatedAt: iso(2) })}`),
    mk(32, "[plan] 둘째저장소 검수 작업", `${plan("둘째저장소 검수 작업", 2, "오메가", "P4")}\n${state({ status: "reviewing", step: 2, passed: { 1: true }, updatedAt: iso(4) })}`),
    mk(33, "[plan] 둘째저장소 승인 작업", `${plan("둘째저장소 승인 작업", 1, "람다")}\n${state({ status: "awaiting_merge", step: 1, passed: { 1: true }, finalPr: 77, updatedAt: iso(8) })}`),
  ];
  // 끝난 run #30: orch:done(state=closed) 응답에만 있음. 진행 단계 P2(ref 30)가 이것으로 자동 완료된다.
  const runsDone = [
    { ...mk(30, "[plan] 둘째저장소 끝난 단계", `${plan("둘째저장소 끝난 단계", 1, "카파")}\n${state({ status: "done", step: 1, passed: { 1: true }, finalPr: 76, updatedAt: iso(90) })}`), state: "closed" },
  ];
  const usageIssue = mk(5, "AI 사용량", `엔진이 갱신하는 AI 사용량입니다.\n\n<!-- orch-usage:v1 ${JSON.stringify(usage)} -->`);
  const variables = [{ name: "ORCH_CODEX", value: "on" }, { name: "ORCH_PAUSED", value: "off" }];
  // app: 다른 프로젝트 화면 링크 (label 없음 → '화면 열기')
  // phases 6개: P1 완료 · P2 ref 30(끝난 run) → 자동 완료 · P3 ref 31(구현 중) → 자동 진행(굵게) · P4 는 #32 계획 JSON phase 로 연결
  // · P5(tasks)·P6 은 item 없는 '예정' · #33 은 단계 미지정 → '단계 2/6 완료'
  const roadmap = {
    version: 1, setup: [{ id: "0.1", title: "둘째로드맵 저장소", status: "done", note: null }], expansion: [], app: { url: "https://example.com/" },
    phases: [
      { id: "P1", title: "둘째진행 기초 공사", status: "done", note: null },
      { id: "P2", title: "둘째진행 연결 완료", status: "todo", note: "끝난 작업으로 자동 완료", ref: 30 },
      { id: "P3", title: "둘째진행 연결 구현", status: "todo", note: null, ref: 31 },
      { id: "P4", title: "둘째진행 마무리", status: "todo", note: null },
      { id: "P5", title: "다섯째 단계", status: "todo", note: null, tasks: [{ title: "다섯째 직접 확인", owner: "me", status: "todo" }, { title: "다섯째 AI 정리", owner: "ai", status: "todo" }] },
      { id: "P6", title: "여섯째 단계", status: "todo", note: null },
    ],
  };
  const roadmapContent = { type: "file", encoding: "base64", content: Buffer.from(JSON.stringify(roadmap)).toString("base64") };
  return (method, url) => {
    if (method !== "GET") return null;
    const p = url.pathname, q = url.searchParams;
    if (p === `/repos/${REPO2}/issues`) {
      const label = q.get("labels");
      if (label === "orch:run") return { status: 200, body: runs };
      if (label === "orch:done" && q.get("state") === "closed") return { status: 200, body: runsDone };
      if (label === "orch:usage") return { status: 200, body: [usageIssue] };
      if (label === null && q.get("state") === "open" && q.get("per_page") === "30") return { status: 200, body: runs.map((i) => ({ ...i, labels: [{ name: "orch:run" }] })) };
      if (label === null && q.get("state") === "all") return { status: 200, body: runs };
      return { status: 200, body: [] };
    }
    if (/^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.test(p)) return { status: 200, body: [] };
    if (p === `/repos/${REPO2}/actions/variables`) return { status: 200, body: { total_count: variables.length, variables } };
    if (p === `/repos/${REPO2}/contents/docs/roadmap.json`) return { status: 200, body: roadmapContent };
    if (p === `/repos/${REPO2}/compare/prod-deployed...main`) return { status: 200, body: { status: "identical", commits: [] } };
    if (p === `/repos/${REPO2}/actions/workflows/usage.yml/runs`) return { status: 200, body: { workflow_runs: [{ created_at: iso(5) }] } };
    return null;
  };
}
