#!/usr/bin/env node
// 결과 화면 테스트 (Playwright). 실제 빌드(`next start`)를 띄우고, 실제 관리자 로그인으로 4개 탭을 폰 크기로 열어 확인한다.
//   - GitHub API는 가짜 서버(fixtures.mjs)로 대체한다 (ORCH_GITHUB_API). 외부 네트워크 요청은 모두 차단·실패 처리.
//   - 운영 쿠키(__Host-, Secure)를 그대로 쓰기 위해 자체 서명 인증서의 HTTPS 프록시를 앞에 둔다.
//   - 스크린샷: SCREENS_DIR (기본 .screens/) 에 <탭>-<폭>.png. CI는 이 폴더를 artifact로 올린다.
// 사용: npm run build && node scripts/screens/run.mjs   (브라우저: CHROMIUM_PATH 또는 playwright 기본 chromium)
import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { githubFixtures, REPO, REPO2, REPO3, REPO4 } from "./fixtures.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.resolve(process.env.SCREENS_DIR || path.join(ROOT, ".screens"));
const WIDTHS = [360, 390, 430];
const CURRENT_VERSION = /version: "(\d+\.\d+\.\d+)"/.exec(fs.readFileSync(path.join(ROOT, "src/lib/patchnotes.ts"), "utf8"))?.[1];

const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const listen = (srv) => new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok(srv.address().port)));

// 스위치 쓰기 시나리오 (머지 전 확인용, 기본 읽기 전용 실행과 분리): SCREENS_SWITCH=ok|partial
//   ok      = 가짜 GitHub 가 두 저장소의 변수 PATCH·dispatch 를 모두 받아들임 → '4개 프로젝트에 적용'
//   partial = 두 번째 저장소 PATCH 만 403 → '일부 실패: orch-second · …'
// 쓰기는 이 프로세스 안의 가짜 서버에만 간다 (운영 저장소 설정은 바꾸지 않음).
const SWITCH = process.env.SCREENS_SWITCH || "";
if (SWITCH && SWITCH !== "ok" && SWITCH !== "partial") { console.error(`SCREENS_SWITCH 는 ok 또는 partial (${SWITCH})`); process.exit(2); }

// ---- fake GitHub API
const gh = githubFixtures(new Date());
const ghCalls = [];
/** switch 시나리오에서 저장된 변수: repo → { NAME: value }. GET variables 응답에 덮어쓴다. */
const varOverrides = new Map();
const setVar = (repo, name, value) => { const m = varOverrides.get(repo) ?? {}; m[name] = value; varOverrides.set(repo, m); };
function fakeWrite(method, p, body) {
  const v = /^\/repos\/([^/]+\/[^/]+)\/actions\/variables\/([A-Z_]+)$/.exec(p);
  if (method === "PATCH" && v) {
    if (SWITCH === "partial" && v[1] === REPO2) return { status: 403, body: { message: "Resource not accessible by integration" } };
    setVar(v[1], v[2], String(body?.value ?? ""));
    return { status: 204 };
  }
  if (method === "POST" && /^\/repos\/[^/]+\/[^/]+\/actions\/workflows\/orchestrator\.yml\/dispatches$/.test(p)) return { status: 204 };
  return null;
}
const ghServer = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  ghCalls.push(`${req.method} ${url.pathname}${url.search}`);
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    let hit = null;
    if (SWITCH && req.method !== "GET") { let b = null; try { b = JSON.parse(raw || "null"); } catch {} hit = fakeWrite(req.method, url.pathname, b); }
    else hit = gh(req.method, url);
    const vm = /^\/repos\/([^/]+\/[^/]+)\/actions\/variables$/.exec(url.pathname);
    if (hit?.status === 200 && vm && req.method === "GET" && varOverrides.has(vm[1])) {
      const over = varOverrides.get(vm[1]);
      const list = (hit.body.variables ?? []).filter((x) => !(x.name in over)).concat(Object.entries(over).map(([name, value]) => ({ name, value })));
      hit = { status: 200, body: { total_count: list.length, variables: list } };
    }
    if (hit?.status === 204) { res.writeHead(204); res.end(); return; }
    res.writeHead(hit ? hit.status : 404, { "content-type": "application/json" });
    res.end(hit?.body === undefined ? JSON.stringify({ message: "Not Found" }) : JSON.stringify(hit.body));
  });
});
const ghPort = await listen(ghServer);

// ---- app (real build) with throwaway admin credentials
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "screens-"));
const user = `u${crypto.randomBytes(8).toString("hex")}`, password = crypto.randomBytes(18).toString("hex");
const salt = crypto.randomBytes(16);
const key = crypto.scryptSync(password, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
const readToken = crypto.randomBytes(24).toString("hex");
const appPort = await freePort();
const log = fs.openSync(path.join(tmp, "server.log"), "w");
const app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(appPort)], {
  cwd: ROOT,
  stdio: ["ignore", log, log],
  env: {
    PATH: process.env.PATH, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", VERCEL_ENV: "preview",
    ADMIN_USERNAME: user, ADMIN_PASSWORD_HASH: `scrypt$131072$8$1$${salt.toString("hex")}$${key.toString("hex")}`,
    CONTROL_ADMIN_TOKEN: crypto.randomBytes(24).toString("hex"),
    CONTROL_READ_TOKEN: readToken, // 읽기 세션 확인용 (일회용)
    ORCH_REPOS: [REPO, REPO2, REPO3, REPO4].join(","), ORCH_GITHUB_TOKEN: "fixture-token", ORCH_GITHUB_API: `http://127.0.0.1:${ghPort}`,
    ORCH_SELF_REPO: REPO, // 자기 저장소 판정(서버): orch-screens 카드에는 '화면 열기' 링크가 없어야 함
    // 앱 링크 환경변수: 자기 저장소 항목은 무시돼야 하고, orch-third(로드맵 app 없음)에는 라벨 링크가 생겨야 함. orch-second 는 넣지 않음(roadmap app 그대로)
    ORCH_APP_URLS: `${REPO}=https://app.example.invalid/self, ${REPO3}=셋째화면|https://app.example.invalid/third`,
  },
});

// ---- HTTPS front so production cookies (__Host-, Secure) and the same-origin check behave as on Vercel
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1",
  "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", path.join(tmp, "key.pem"), "-out", path.join(tmp, "cert.pem")], { stdio: "ignore" });
const proxy = https.createServer({ key: fs.readFileSync(path.join(tmp, "key.pem")), cert: fs.readFileSync(path.join(tmp, "cert.pem")) }, (req, res) => {
  const up = http.request({ host: "127.0.0.1", port: appPort, method: req.method, path: req.url, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on("error", () => { res.writeHead(502); res.end(); });
  req.pipe(up);
});
const base = `https://127.0.0.1:${await listen(proxy)}`;

const problems = [];
const shots = [];
let browser;
try {
  for (let i = 0; ; i++) {
    try { const r = await fetch(`http://127.0.0.1:${appPort}/api/session`); if (r.ok) break; } catch {}
    if (i > 150) throw new Error("server did not become ready (see server.log)");
    await new Promise((r) => setTimeout(r, 200));
  }
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "ko-KR" });
  let page = await context.newPage(); // 읽기 세션 확인 동안만 다른 page 로 바꿔 낀다
  const pageErrors = [], external = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.route("**/*", (r) => (r.request().url().startsWith(base) ? r.continue() : (external.push(r.request().url()), r.abort())));

  // login with the real form
  await page.goto(`${base}/projects`);
  await page.getByLabel("아이디", { exact: true }).fill(user);
  await page.getByLabel("비밀번호", { exact: true }).fill(password);
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await page.getByRole("navigation", { name: "주 메뉴" }).waitFor();
  await page.getByText("계정 · 로그인됨").first().waitFor({ timeout: 15000 });

  /** Each tab: path, nav label, texts that must appear (from fixtures), texts that must not. */
  const TABS = [
    { name: "projects", path: "/projects", nav: "프로젝트", expect: ["남은 할 일", "배포 대기 3", "완료 기록", "인프라", "확장", "추가 검토", "계획", "개발", "통합"], forbid: ["설정되지 않았습니다", "로드맵 없음", "로드맵 읽기 실패", "흐름 보기", "5 완료", "다음 배포까지", "끝난 시험 작업", "배포된 시험 작업", "Vercel에 배포"] },
    { name: "agents", path: "/agents", nav: "AI 팀", expect: ["AI 사용량", "42% 사용", "AI ON/OFF"], forbid: ["확인 불가"] },
    { name: "briefing", path: "/briefing", nav: "PM 브리핑", expect: ["결정 필요", "승인 대기 시험 작업", "orch-screens #12", "승인 대기 계획", "승인 기다리는 시험 계획", "감사 OK 2/3", "아이디어함", "상황판 채팅", "알림 모아보기", "묻고 답하는 흐름을 먼저 붙이면 효과가 큽니다", "의견 수집 중", "아이디어 적기"], forbid: ["승인 대기 계획 없음"] },
    { name: "architecture", path: "/architecture", nav: "구조", expect: ["요청만 하면 AI 팀이 계획부터 반영까지 알아서 개발", "둘째 프로젝트의 시험용 구조 문서", "구조 문서 없음", "구조 읽기 실패"], forbid: [] }, // 기존 문구 5개(아키텍처…Playwright)는 자기 카드를 펼친 뒤 검사
    { name: "patch-notes", path: "/patch-notes", nav: "패치노트", expect: [`v${CURRENT_VERSION}`, "ai-orchestrator", "v2.x", "v1.x", "새 디자인과 전체 흐름"], forbid: [] },
  ];
  const navLabels = (await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("link").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
  for (const t of TABS) if (!navLabels.some((l) => l.includes(t.nav))) problems.push(`하단 탭에 '${t.nav}' 없음 (${navLabels.join(", ")})`);

  // 스위치 카드: 카드 하나에 스위치 한 벌(4개 + 작업 시간대), 저장소별 카드 없음, 두 가짜 저장소 Codex 값이 달라 '일부 프로젝트 값이 다름'
  const SWITCH_NAMES = ["Claude Sonnet (구현)", "Claude Opus (고난도 구현·대체 검수)", "Codex (독립 검수)", "Codex 개발 대체 (Claude 한도일 때)", "전체 일시정지", "자동 모드 (시작·반영 자동)"];
  const checkSwitchCard = async (who) => {
    const sec = page.getByTestId("orch-switches");
    try { await sec.getByRole("switch").first().waitFor({ timeout: 15000 }); } catch { problems.push(`[${who}] 스위치가 보이지 않음`); return; }
    const cards = await sec.getByTestId("orch-switch-card").count();
    if (cards !== 1) problems.push(`[${who}] 스위치 카드가 1개가 아님 (${cards})`);
    const secText = ((await sec.textContent()) ?? "").replace(/\s+/g, " ");
    for (const want of ["AI ON/OFF", "등록된 모든 프로젝트에 한 번에 적용", "끄면 새 작업만 막고", "작업 시간대 (한국시간, 비우면 항상)", ...SWITCH_NAMES]) if (!secText.includes(want)) problems.push(`[${who}] 스위치 영역에 '${want}' 이 없음`);
    const sw = sec.getByRole("switch");
    if ((await sw.count()) !== SWITCH_NAMES.length) problems.push(`[${who}] 스위치가 ${SWITCH_NAMES.length}개가 아님 (${await sw.count()}) — 저장소별로 반복되면 안 됨`);
    for (const n of SWITCH_NAMES) if ((await sec.getByRole("switch", { name: n, exact: true }).count()) !== 1) problems.push(`[${who}] '${n}' 스위치가 1개가 아님`);
    if ((await sec.locator("h3").filter({ hasText: /orch-screens|orch-second/ }).count()) || (await sec.locator('[aria-label*="orch-"]').count())) problems.push(`[${who}] 저장소별 스위치 카드가 남아 있음`);
    if ((await sec.locator("input#win-all").count()) !== 1 || (await sec.locator("input").count()) !== 1) problems.push(`[${who}] 작업 시간대 입력이 하나가 아님`);
    const diff = sec.getByTestId("orch-switch-differs");
    const diffText = ((await diff.textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
    if (!diffText.includes("일부 프로젝트 값이 다름: Codex(orch-second)")) problems.push(`[${who}] '일부 프로젝트 값이 다름: Codex(orch-second)' 가 없음 (${diffText})`);
    if (!/text-warn/.test((await diff.locator("p").getAttribute("class").catch(() => "")) ?? "")) problems.push(`[${who}] '일부 프로젝트 값이 다름' 줄이 warn 색이 아님`);
    return { sec, align: diff.getByRole("button", { name: "모두 맞추기" }) };
  };

  for (const t of SWITCH ? [] : TABS) {
    // reach the tab through the bottom nav, as a user would
    await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("link", { name: new RegExp(t.nav) }).click();
    await page.waitForURL((u) => u.pathname.startsWith(t.path) || (t.path === "/projects" && u.pathname === "/"));
    for (const text of t.expect) {
      try { await page.getByText(text, { exact: false }).first().waitFor({ timeout: 15000 }); }
      catch { problems.push(`[${t.name}] '${text}' 가 보이지 않음`); }
    }
    if (t.name === "briefing" && !(await page.locator('a[href$="/issues/12"]').count())) problems.push("[briefing] 카드의 Issue(#12) 링크가 없음");
    if (t.name === "briefing") {
      // 승인 대기 계획 카드: 관리자 로그인이므로 '승인' 버튼이 보여야 함. 누르지는 않는다 (화면 테스트는 읽기 전용).
      try { await page.getByRole("button", { name: "승인", exact: true }).first().waitFor({ state: "visible", timeout: 15000 }); }
      catch { problems.push("[briefing] 승인 대기 계획의 '승인' 버튼이 보이지 않음"); }
      if (!(await page.locator('a[href$="/issues/13"]').count())) problems.push("[briefing] 승인 대기 계획(#13)의 '계획 보기' 링크가 없음");
    }
    if (t.name === "briefing") {
      // 아이디어함: 저장소가 2개(orch-screens·orch-second)라 프로젝트 칩 줄이 보임, 관리자에게 입력창(항목·내 의견·등록)이 보임. 등록은 누르지 않는다 (읽기 전용).
      {
        const chips = page.getByRole("group", { name: "프로젝트 필터" });
        if (!(await chips.count())) problems.push("[briefing] 프로젝트가 2개인데 필터 칩 줄이 없음");
        else for (const c of ["전체", "orch-screens", "orch-second"]) if (!(await chips.getByRole("button", { name: new RegExp(c) }).count())) problems.push(`[briefing] 프로젝트 필터 칩 '${c}' 이 없음`);
      }
      for (const [label, el] of [["항목", page.getByLabel("항목", { exact: false })], ["내 의견", page.getByLabel("내 의견", { exact: false })], ["등록", page.getByRole("button", { name: "등록", exact: true })]]) {
        try { await el.first().waitFor({ state: "visible", timeout: 5000 }); } catch { problems.push(`[briefing] 아이디어 입력창의 '${label}' 가 보이지 않음`); }
      }
      // 날짜는 요일 형식 (예: 11/21(토) 14:00 KST)
      const dates = await page.locator('article[data-testid^="orch-idea-"]').first().innerText();
      if (!/\d{1,2}\/\d{1,2}\([월화수목금토일]\) \d{2}:\d{2} KST/.test(dates)) problems.push(`[briefing] 아이디어 카드 날짜가 요일 형식이 아님: ${JSON.stringify(dates.slice(0, 200))}`);
      if (!(await page.locator('a[href$="/issues/21"]').count())) problems.push("[briefing] 아이디어(#21) '원문 보기' 링크가 없음");
    }
    if (t.name === "agents") {
      // AI 팀 탭 맨 위 '지금 일하는 AI' 카드: 제목, 네 줄 이름, 두 저장소에 걸친 예시 작업 (구현 중 · 검수 중 · 승인 대기 · 쉬는 중)
      const agentsCard = page.getByTestId("orch-agents");
      const text1 = async (loc) => ((await loc.textContent()) ?? "").replace(/\s+/g, " ").trim();
      const agentsText = await text1(agentsCard);
      if (!(await page.getByRole("heading", { name: "지금 일하는 AI" }).count())) problems.push("[agents] '지금 일하는 AI' 제목이 없음");
      for (const [id, name, wants] of [
        ["sonnet", "Sonnet", ["orch-screens", "#11", "상황판 시험 작업", "Step 2/3", "구현 중", "orch-second", "#31", "둘째저장소 구현 작업", "Step 1/2"]],
        ["opus", "Opus", ["쉬는 중"]],
        ["codex", "Codex", ["orch-second", "#32", "둘째저장소 검수 작업", "Step 2/2", "검수 중"]],
        ["user", "사용자", ["#12", "승인 대기 시험 작업", "#33", "둘째저장소 승인 작업", "반영 승인 대기"]],
      ]) {
        const t = await text1(page.getByTestId(`orch-agent-${id}`));
        if (!t.startsWith(name)) problems.push(`[agents] '지금 일하는 AI' ${name} 줄이 없음 (${t.slice(0, 80)})`);
        for (const want of wants) if (!t.includes(want)) problems.push(`[agents] '지금 일하는 AI' ${name} 줄에 '${want}' 이 없음 (${t.slice(0, 200)})`);
      }
      if (!agentsText.includes("쉬는 중")) problems.push("[agents] '지금 일하는 AI' 에 '쉬는 중' 이 없음");
      if (!(await agentsCard.locator('a[href$="/issues/31"][target="_blank"]').count())) problems.push("[agents] '지금 일하는 AI' #31 Issue 링크가 없음");
      // 맨 위: 'AI 사용량' 보다 위
      const nowTop = await page.getByRole("heading", { name: "지금 일하는 AI" }).evaluate((h) => h.getBoundingClientRect().top);
      const usageTop = await page.getByRole("heading", { name: "AI 사용량" }).evaluate((h) => h.getBoundingClientRect().top);
      if (nowTop >= usageTop) problems.push("[agents] '지금 일하는 AI' 가 'AI 사용량' 보다 위에 있지 않음");
      // 스위치 카드 (관리자 + 쓰기 토큰): 스위치·'모두 맞추기'는 눌 수 있는 상태. 누르지는 않는다 (읽기 전용).
      const sc = await checkSwitchCard("agents");
      if (sc) {
        if (!(await sc.align.isEnabled().catch(() => false))) problems.push("[agents] 관리자 세션에서 '모두 맞추기' 가 비활성");
        if (!(await sc.sec.getByRole("switch", { name: "Codex (독립 검수)" }).isEnabled())) problems.push("[agents] 관리자 세션에서 Codex 스위치가 비활성");
      }
    }
    if (t.name === "projects") {
      // 홈에는 '지금 일하는 AI' 가 없다 (AI 팀 탭으로 옮김)
      if ((await page.getByRole("heading", { name: "지금 일하는 AI" }).count()) || (await page.getByTestId("orch-agents").count())) problems.push("[projects] 홈에 '지금 일하는 AI' 가 있음 (AI 팀 탭에만 있어야 함)");
      // 기본 상태: 인프라·확장 목록, 단계 줄 4개, 작업 항목 모두 접힘 (줄의 요약·개수만 보임).
      for (const hidden of ["로드맵시험 저장소", "확장시험 두번째 저장소", "알파공정 2단계 제목", "알파공정 3단계 확인항목", "3.10 독립 검수", "알림 모아보기", "승인 기다리는 시험 계획", "상황판 시험 작업", "전체 39과정 중", "개발 여부를 정함"]) {
        if (await page.getByText(hidden).first().isVisible()) problems.push(`[projects] 접힌 내용 '${hidden}' 이 기본 상태에서 보임`);
      }
      const card = page.getByTestId("orch-project-orch-screens");
      const flat = async (loc) => ((await loc.textContent()) ?? "").replace(/\s+/g, " ").trim();
      // 카드 머리: '배포 대기 3 · 완료 기록' (compare 머지 커밋 3개), '완료 기록' 은 /patch-notes 링크
      const head = await flat(card.getByTestId("orch-deploy-pending"));
      if (!head.startsWith("배포 대기 3 · 완료 기록")) problems.push(`[projects] 카드 머리가 '배포 대기 3 · 완료 기록' 이 아님 (${head})`);
      const doneLink = card.getByRole("link", { name: "완료 기록" });
      if (!(await doneLink.isVisible()) || !/\/patch-notes$/.test((await doneLink.getAttribute("href")) ?? "")) problems.push("[projects] '완료 기록' 이 /patch-notes 로 가는 링크가 아님");
      // 남은 할 일 (fixtures, 지금 과정도 남은 것으로 셈, 아이디어는 '추가 검토'라 제외): 계획 #13 2.8→2+16+8=26, #11 3.7→10+8=18, #12 4.7→2 = 46
      const remain = await flat(card.getByTestId("orch-remaining"));
      if (remain !== "남은 할 일 46과정 · 단계별 · 직접 할 일 2건") problems.push(`[projects] '남은 할 일 46과정 · 단계별 · 직접 할 일 2건' 이 아님 (${remain})`);
      // 직접 할 일: 인프라 중 안 끝난 것(fixtures 0.2 진행 · 0.3 할 일), 확장은 넣지 않음
      const todoText = await flat(card.getByTestId("orch-todo"));
      if (!todoText.startsWith("직접 할 일 2") || !todoText.includes("0.2") || !todoText.includes("0.3") || todoText.includes("6.1")) problems.push(`[projects] '직접 할 일' 이 인프라 미완료 2건이 아님 (${todoText})`);
      // 3칸(계획·개발·통합): 단계 안 남은 과정(여럿이면 가장 많이 남은 값)/단계 세부 개수. 검토는 칸 없이 아래 '추가 검토'
      const CELLS = [[2, "계획2/9"], [3, "개발10/16"], [4, "통합2/8"]];
      for (const [n, want] of CELLS) {
        const got = (await flat(card.getByTestId(`orch-cell-${n}`))).replace(/ /g, "");
        if (got !== want) problems.push(`[projects] ${n}번 칸이 '${want}' 이 아님 (${got})`);
      }
      if (await card.getByTestId("orch-cell-5").count() || await card.getByTestId("orch-cell-1").count()) problems.push("[projects] 1번·5번 칸이 있음 (계획·개발·통합 3칸이어야 함)");
      // 추가 검토는 작업 흐름 아래 따로
      const reviewSec = card.getByTestId("orch-review");
      if (!(await reviewSec.count()) || !(await reviewSec.getByTestId("orch-stage-1").count())) problems.push("[projects] '추가 검토' 절에 1 검토 줄이 없음");
      if (await card.getByTestId("orch-flow").getByTestId("orch-stage-1").count()) problems.push("[projects] 1 검토 줄이 작업 흐름 안에 있음 (따로 있어야 함)");
      // 단계 줄 4개 '번호 단계 #번호… 상태 · 개수' (5 완료 없음), 기본 접힘
      const rowCount = await card.locator('[data-testid^="orch-stage-"]:not([data-testid^="orch-stage-process"])').count();
      if (rowCount !== 4) problems.push(`[projects] 단계 줄이 4개가 아님 (${rowCount})`);
      const ROWS = [[1, "검토", "#22 · #21 의견 수집 중", 2], [2, "계획", "#13 승인 대기", 1], [3, "개발", "#11 구현 중 · Step 2/3", 1], [4, "통합", "#12 반영 승인 대기", 1]];
      for (const [n, title, note, count] of ROWS) {
        const row = card.getByTestId(`orch-stage-${n}`);
        const line = await flat(row.locator(":scope > summary"));
        if (!line.startsWith(`${n} ${title} ${note}`) || !line.endsWith(`· ${count}`)) problems.push(`[projects] 단계 줄이 '${n} ${title} ${note} … · ${count}' 이 아님 (${line})`);
        if (n === 4 && !line.includes("확인 필요 1")) problems.push(`[projects] 4 통합 줄에 '확인 필요 1' 이 없음 (${line})`);
        if (await row.evaluate((el) => el.open)) problems.push(`[projects] '${n} ${title}' 줄이 기본 상태에서 펼쳐져 있음`);
      }
      // 항목이 제 줄에 있는지: 1 아이디어 2개, 2 계획, 3 구현 중 run, 4 반영 승인 대기 run (끝난 run 은 없음)
      const inStage = async (n) => card.getByTestId(`orch-stage-${n}`).locator('[data-testid^="orch-run-orch"], [data-testid^="orch-plan-"], [data-testid^="orch-idea-"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
      const PLACED = { 1: "orch-idea-orch-screens-22,orch-idea-orch-screens-21", 2: "orch-plan-orch-screens-13", 3: "orch-run-orch-screens-11", 4: "orch-run-orch-screens-12" };
      for (const [n, want] of Object.entries(PLACED)) {
        const got = (await inStage(n)).join();
        if (got !== want) problems.push(`[projects] ${n}줄 항목이 '${want}' 이 아님 (${got})`);
      }
      // 작업 카드 (줄은 접혀 있으므로 textContent): '지금 S.K 세부이름 · Step k/N' 과 '전체 39과정 중 x 완료 · 남은 y (…)'
      const RUNS = [
        [3, 11, "#11 상황판 시험 작업", "지금 3.7 구현 · Step 2/3", "전체 39과정 중 21 완료 · 남은 18 (개발 10 · 통합 8)"],
        [4, 12, "#12 승인 대기 시험 작업", "지금 4.7 반영·승인 · Step 2/2", "전체 39과정 중 37 완료 · 남은 2 (통합 2)"],
      ];
      for (const [n, num, title, now, total] of RUNS) {
        const item = card.getByTestId(`orch-stage-${n}`).getByTestId(`orch-run-orch-screens-${num}`);
        const text = await flat(item);
        for (const want of [title, now, total]) if (!text.includes(want)) problems.push(`[projects] #${num} 작업 카드에 '${want}' 이 없음 (${text.slice(0, 200)})`);
        if (!(await item.locator('[role="progressbar"][aria-label="전체 과정"]').count())) problems.push(`[projects] #${num} 작업 카드에 전체 과정 막대가 없음`);
      }
      if (!(await page.getByTestId("orch-run-orch-screens-12").getByText("사용자 확인 필요").count())) problems.push("[projects] #12 작업 카드에 '사용자 확인 필요' 배지가 없음");
      if (!(await page.getByTestId("orch-plan-orch-screens-13").locator('a[href$="/issues/13"]').count())) problems.push("[projects] 계획(#13) 항목에 '열기' 링크가 없음");
      // 인프라 1/3 (완료 1개 / 3개) ─ 막대 ─ 확장 0/1 (na 제외) 한 줄
      const roadLine = await flat(card.getByTestId("orch-roadmap").locator(":scope > summary"));
      if (!/^인프라 1\/3 확장 0\/1$/.test(roadLine)) problems.push(`[projects] 로드맵 줄이 '인프라 1/3 ─ 확장 0/1' 이 아님 (${roadLine})`);
      // 기본 상태 높이: 360x800 에서 첫 프로젝트 카드 600px 이하
      await page.setViewportSize({ width: 360, height: 800 });
      await page.waitForTimeout(150);
      const cardH = await page.getByTestId("orch-project-orch-screens").evaluate((el) => (el.parentElement ?? el).getBoundingClientRect().height);
      console.log(`projects: 첫 프로젝트 카드 높이 ${Math.round(cardH)}px (360x800, 기본 상태)`);
      if (cardH > 600) problems.push(`[projects] 360x800 에서 첫 프로젝트 카드 높이 ${Math.round(cardH)}px > 600px`);
      await page.setViewportSize({ width: 390, height: 844 });
      // 'PM에게 말하기' 바로가기: 새 창 링크
      const pmLink = page.getByRole("link", { name: "PM에게 말하기" });
      if (!(await pmLink.isVisible())) problems.push("[projects] 'PM에게 말하기' 링크가 보이지 않음");
      else if ((await pmLink.getAttribute("target")) !== "_blank" || !/noreferrer/.test((await pmLink.getAttribute("rel")) ?? "") || !/^https?:\/\//.test((await pmLink.getAttribute("href")) ?? "")) problems.push("[projects] 'PM에게 말하기' 링크가 새 창(_blank, noreferrer, http 주소)이 아님");
      // 새로고침 버튼: 보이고, 누르면(GET 만 발생) '방금 갱신' 시각이 나와야 함
      const refreshBtn = page.getByRole("button", { name: "새로고침", exact: true });
      if (!(await refreshBtn.isVisible())) problems.push("[projects] '새로고침' 버튼이 보이지 않음");
      else {
        await refreshBtn.click();
        try { await page.getByText("방금 갱신", { exact: false }).first().waitFor({ state: "visible", timeout: 10000 }); }
        catch { problems.push("[projects] 새로고침을 눌러도 '방금 갱신' 이 안 보임"); }
      }
    }
    for (const text of t.forbid) if (await page.getByText(text, { exact: false }).count()) problems.push(`[${t.name}] '${text}' 가 보임`);
    // 밝은 테마 + Pretendard: body 배경 rgb(246, 247, 249), 글꼴에 Pretendard
    const bodyStyle = await page.evaluate(() => { const cs = getComputedStyle(document.body); return { bg: cs.backgroundColor, font: cs.fontFamily }; });
    if (bodyStyle.bg !== "rgb(246, 247, 249)") problems.push(`[${t.name}] body 배경이 rgb(246, 247, 249) 가 아님 (${bodyStyle.bg})`);
    if (!bodyStyle.font.includes("Pretendard")) problems.push(`[${t.name}] body 글꼴에 Pretendard 가 없음 (${bodyStyle.font})`);
    // 하단 탭 아이콘은 SVG (글자 기호 아님)
    const navSvgs = await page.getByRole("navigation", { name: "주 메뉴" }).locator("a svg").count();
    if (navSvgs !== TABS.length) problems.push(`[${t.name}] 하단 탭 SVG 아이콘이 ${TABS.length}개가 아님 (${navSvgs})`);
    const active = await page.getByRole("navigation", { name: "주 메뉴" }).locator('[aria-current="page"]').allInnerTexts();
    if (!active.some((a) => a.includes(t.nav))) problems.push(`[${t.name}] 활성 탭 표시가 '${t.nav}' 아님 (${active.join(",")})`);
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: 844 });
      await page.waitForTimeout(150);
      if (await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)) problems.push(`[${t.name}] ${w}px 에서 가로 넘침`);
      fs.mkdirSync(OUT, { recursive: true });
      const file = path.join(OUT, `${t.name}-${w}.png`);
      await page.screenshot({ path: file, fullPage: true });
      shots.push(path.relative(ROOT, file));
    }
    await page.setViewportSize({ width: 390, height: 844 });
    if (t.name === "architecture") {
      // 구조 탭: 카드 4개(자기 · orch-second · orch-third · orch-fourth), 처음엔 모두 접힘. 기존 구조 문구 검사는 자기 카드를 '펼친 뒤'에 한다.
      const cardOf = (n) => page.getByTestId(`arch-project-${n}`);
      const tog = (n) => cardOf(n).getByTestId("arch-toggle");
      const noteOf = async (n) => (((await cardOf(n).getByTestId("arch-note").textContent()) ?? "").replace(/\s+/g, " ").trim());
      const SELF = "self";
      if ((await page.getByTestId("arch-project-self").count()) !== 1) problems.push("[architecture] 자기 저장소 카드가 없음");
      for (const n of [SELF, "orch-second", "orch-third", "orch-fourth"]) {
        if (!(await cardOf(n).count())) { problems.push(`[architecture] '${n}' 카드가 없음`); continue; }
        if ((await tog(n).getAttribute("aria-expanded")) !== "false") problems.push(`[architecture] '${n}' 카드가 처음부터 펼쳐져 있음`);
        const ctl = await tog(n).getAttribute("aria-controls");
        if (!ctl || ctl !== (await cardOf(n).getByTestId("arch-body").getAttribute("id"))) problems.push(`[architecture] '${n}' aria-controls 가 본문 id 와 다름`);
        const box = await tog(n).boundingBox();
        if (!box || box.height < 44) problems.push(`[architecture] '${n}' 머리 버튼 높이 ${box?.height}px < 44px`);
      }
      if (await page.getByTestId("arch-diagram").count()) problems.push("[architecture] 접힌 상태인데 구조도(arch-diagram)가 있음");
      for (const h of ["배포 · 비밀값", "보조 도구", "둘째구조 글과 표 시험"]) if (await page.getByText(h, { exact: false }).count()) problems.push(`[architecture] 접힌 상태인데 섹션 머리 '${h}' 이 보임`);
      if ((await noteOf(SELF)) !== "요청만 하면 AI 팀이 계획부터 반영까지 알아서 개발") problems.push(`[architecture] 자기 카드 목적 문구가 다름 (${await noteOf(SELF)})`);
      if ((await noteOf("orch-second")) !== "둘째 프로젝트의 시험용 구조 문서") problems.push(`[architecture] orch-second purpose 가 다름 (${await noteOf("orch-second")})`);
      if (!(await noteOf("orch-third")).startsWith("구조 문서 없음")) problems.push(`[architecture] orch-third 문구가 '구조 문서 없음' 이 아님 (${await noteOf("orch-third")})`);
      if (!(await noteOf("orch-fourth")).startsWith("구조 읽기 실패")) problems.push(`[architecture] orch-fourth 문구가 '구조 읽기 실패' 가 아님 (${await noteOf("orch-fourth")})`);
      if (!/text-danger/.test((await cardOf("orch-fourth").getByTestId("arch-note").getAttribute("class")) ?? "")) problems.push("[architecture] 구조 읽기 실패 문구가 danger 색이 아님");
      // 자기 카드를 펼친다: 기존 구조 탭 문구 5개 + 구조도
      await tog(SELF).click();
      for (const text of ["아키텍처", "배포 · 비밀값", "보조 도구", "Impeccable", "Playwright", "매시 7·27·47분", "멈추면 바로", "자동 모드·Codex 켜짐일 때 Codex PM", "자동으로 풀 수 있으면", "사람 판단 요청", "최종 PR 문제·3회 소진", "재감사 없이 시작", "deploy 워크플로"]) {
        try { await page.getByText(text, { exact: false }).first().waitFor({ timeout: 15000 }); }
        catch { problems.push(`[architecture] 자기 카드를 펼쳐도 '${text}' 가 보이지 않음`); }
      }
      if ((await page.getByText("20분마다", { exact: false }).count()) || (await page.getByText("예약 작업", { exact: false }).count())) problems.push("[architecture] 옛 순찰·점검 문구가 남아 있음");
      if (!(await page.getByTestId("arch-diagram").count())) problems.push("[architecture] 자기 카드를 펼쳐도 arch-diagram 이 없음");
      // orch-second 를 펼친다: 섹션 2개, 표, svg, 글자는 같은 g 의 rect 안
      await tog("orch-second").click();
      const sec2 = cardOf("orch-second");
      try { await sec2.locator("svg[role=img]").waitFor({ timeout: 10000 }); } catch { problems.push("[architecture] orch-second 를 펼쳐도 svg[role=img] 가 없음"); }
      if ((await sec2.locator("section").count()) !== 2) problems.push(`[architecture] orch-second 섹션이 2개가 아님 (${await sec2.locator("section").count()})`);
      if ((await sec2.locator("table").count()) !== 1) problems.push("[architecture] orch-second 표가 1개가 아님");
      if ((await sec2.locator("svg[role=img]").getAttribute("aria-label")) !== "둘째구조 시험 그림") problems.push("[architecture] 다이어그램 aria-label 이 다름");
      if ((await sec2.locator("svg[role=img] g").count()) !== 4) problems.push(`[architecture] 다이어그램 상자(g)가 4개가 아님 (${await sec2.locator("svg[role=img] g").count()})`);
      if ((await sec2.locator("svg[role=img] polyline").count()) !== 3) problems.push("[architecture] 다이어그램 화살표가 3개가 아님");
      const bad = await sec2.locator("svg[role=img]").evaluate((svg) => {
        const out = [];
        let withText = 0;
        svg.querySelectorAll("g").forEach((g, i) => {
          const rect = g.querySelector("rect"), r = rect.getBBox();
          g.querySelectorAll("text").forEach((t) => {
            withText++;
            const b = t.getBBox();
            if (b.x < r.x - 0.5 || b.y < r.y - 0.5 || b.x + b.width > r.x + r.width + 0.5 || b.y + b.height > r.y + r.height + 0.5) out.push(`상자 ${i + 1}: 글자 ${JSON.stringify(t.textContent)} (${b.x.toFixed(1)},${b.y.toFixed(1)},${b.width.toFixed(1)}×${b.height.toFixed(1)}) 가 상자 (${r.x},${r.y},${r.width}×${r.height}) 밖`);
          });
        });
        if (withText !== 3) out.push(`글자가 있는 줄이 3개가 아님 (${withText}): 폭 16 상자와 높이 18 상자는 글자가 없어야 함`);
        return out;
      });
      for (const b of bad) problems.push(`[architecture] ${b}`);
      const narrow = await sec2.locator("svg[role=img] g").nth(1).locator("text").allTextContents();
      if (narrow.join("") !== "좁…") problems.push(`[architecture] 좁은 상자(w 40) 글자가 '좁…' 이 아님 (${narrow.join("|")})`);
      const syncOpen = () => page.evaluate(() => localStorage.getItem("orch.arch.open"));
      for (const w of WIDTHS) {
        await page.setViewportSize({ width: w, height: 844 });
        await page.waitForTimeout(150);
        if (await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)) problems.push(`[architecture-expanded] ${w}px 에서 가로 넘침`);
        const cell = await sec2.locator("td").filter({ hasText: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd" }).evaluate((td) => ({ r: td.getBoundingClientRect().right, tr: td.closest("table").getBoundingClientRect().right, vw: document.documentElement.clientWidth, sw: td.scrollWidth, cw: td.clientWidth }));
        if (cell.r > cell.vw || cell.r > cell.tr + 0.5 || cell.sw > cell.cw + 1) problems.push(`[architecture-expanded] ${w}px 에서 긴 단일 문자열 칸이 넘침 (${JSON.stringify(cell)})`);
        const file = path.join(OUT, `architecture-expanded-${w}.png`);
        await page.screenshot({ path: file, fullPage: true });
        shots.push(path.relative(ROOT, file));
      }
      await page.setViewportSize({ width: 390, height: 844 });
      const saved = JSON.parse((await syncOpen()) ?? "[]");
      if (![SELF, "example/orch-second"].every((x) => saved.includes(x))) problems.push(`[architecture] localStorage 'orch.arch.open' 값이 다름 (${JSON.stringify(saved)})`);
      await page.reload();
      try { await page.waitForFunction(() => document.querySelector('[data-testid="arch-project-orch-second"] [data-testid="arch-toggle"]')?.getAttribute("aria-expanded") === "true", null, { timeout: 15000 }); }
      catch { problems.push("[architecture] 새로고침 뒤 orch-second 펼침이 유지되지 않음"); }
      if ((await tog(SELF).getAttribute("aria-expanded")) !== "true") problems.push("[architecture] 새로고침 뒤 자기 카드 펼침이 유지되지 않음");
      if ((await tog("orch-third").getAttribute("aria-expanded")) !== "false") problems.push("[architecture] 새로고침 뒤 펼치지 않은 카드가 펼쳐져 있음");
    }
    if (t.name === "projects") {
      const card =page.getByTestId("orch-project-orch-screens"); // 저장소가 둘이므로 단계 줄·로드맵은 첫 카드 안에서만 찾는다
      // 펼친 상태: 인프라·확장 목록 · 단계 줄 4개(설명·세부 과정·항목 카드) · 작업 카드의 스텝 보기 · 대기 스텝
      const expand = async (summary, shown, what) => {
        await summary.click();
        try { await page.getByText(shown).first().waitFor({ state: "visible", timeout: 5000 }); }
        catch { problems.push(`[projects] ${what} 를 펼쳐도 '${shown}' 이 안 보임`); }
      };
      // ':scope > summary': 펼친 작업 카드 안에는 스텝 <summary> 도 있으므로 바로 아래 summary 만 고른다
      await expand(card.getByTestId("orch-roadmap").locator(":scope > summary"), "0.1 로드맵시험 저장소", "'인프라 · 확장' 줄");
      for (const item of ["0.2 로드맵시험 배포", "0.3 로드맵시험 알림", "6.1 확장시험 두번째 저장소"]) {
        if (!(await page.getByText(item).first().isVisible())) problems.push(`[projects] 인프라·확장 줄을 펼쳐도 '${item}' 이 안 보임`);
      }
      await expand(card.getByTestId("orch-stage-1").locator(":scope > summary"), "알림 모아보기", "'1 검토'");
      await expand(card.getByTestId("orch-stage-2").locator(":scope > summary"), "승인 기다리는 시험 계획", "'2 계획'");
      await expand(card.getByTestId("orch-stage-3").locator(":scope > summary"), "상황판 시험 작업", "'3 개발'");
      // 펼친 줄에는 단계 설명이 보임
      for (const d of ["개발 여부를 정함", "감사 후 사용자 승인", "독립 검수 → CI"]) {
        if (!(await page.getByText(d).first().isVisible())) problems.push(`[projects] 펼친 줄의 단계 설명 '${d}' 이 보이지 않음`);
      }
      // 세부 과정: 3 개발 16개, 지금 있는 3.7 은 굵게 + '#11' 꼬리표
      const proc3 = card.getByTestId("orch-stage-process-3").locator("li");
      if ((await proc3.count()) !== 16) problems.push(`[projects] 3 개발 세부 과정이 16개가 아님 (${await proc3.count()})`);
      if (!/font-bold/.test((await proc3.nth(6).getAttribute("class")) ?? "") || !((await proc3.nth(6).textContent()) ?? "").includes("#11")) problems.push("[projects] 3 개발 세부 과정에서 지금 위치(3.7 구현)가 굵게+'#11' 로 표시되지 않음");
      if (!(await page.getByText("전체 39과정 중 21 완료").first().isVisible())) problems.push("[projects] 3 개발을 펼쳐도 #11 작업 카드의 '전체 39과정 중' 이 안 보임");
      await expand(card.getByTestId("orch-stage-4").locator(":scope > summary"), "충돌 처리 후 main 반영", "'4 통합'");
      if (!(await card.getByTestId("orch-run-orch-screens-12").isVisible())) problems.push("[projects] 4 통합을 펼쳐도 #12 작업 카드가 안 보임");
      await expand(card.getByTestId("orch-run-steps-orch-screens-11").locator(":scope > summary"), "알파공정 2단계 확인항목", "#11 작업 카드의 '스텝 보기'");
      for (const text of ["스텝 1/3 통과", "지금 2번"]) {
        if (!(await page.getByText(text).first().isVisible())) problems.push(`[projects] #11 스텝 보기를 펼쳐도 '${text}' 이 안 보임`);
      }
      await page.getByText("Step 3. 알파공정 3단계 제목").click();
      try { await page.getByText("알파공정 3단계 확인항목").waitFor({ state: "visible", timeout: 5000 }); }
      catch { problems.push("[projects] 대기 스텝을 눌러도 할 일이 안 보임"); }
      for (const w of WIDTHS) {
        await page.setViewportSize({ width: w, height: 844 });
        await page.waitForTimeout(150);
        if (await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)) problems.push(`[projects-expanded] ${w}px 에서 가로 넘침`);
        const file = path.join(OUT, `projects-expanded-${w}.png`);
        await page.screenshot({ path: file, fullPage: true });
        shots.push(path.relative(ROOT, file));
      }
      await page.setViewportSize({ width: 390, height: 844 });

      // 다른 프로젝트 화면 링크: orch-second(roadmap app, label 없음) → '화면 열기' 새 탭, 자기 저장소(ORCH_SELF_REPO=orch-screens)는 app 이 있어도 링크 없음
      const second = page.getByTestId("orch-project-orch-second");
      const appLink = second.getByTestId("orch-app-link");
      if ((await appLink.count()) !== 1) problems.push(`[projects] orch-second 카드에 '화면 열기' 링크가 1개가 아님 (${await appLink.count()})`);
      else {
        const [href, target, rel, text, inButton] = [await appLink.getAttribute("href"), await appLink.getAttribute("target"), (await appLink.getAttribute("rel")) ?? "", ((await appLink.textContent()) ?? "").trim(), await appLink.evaluate((el) => !!el.closest("button"))];
        if (href !== "https://example.com/") problems.push(`[projects] orch-second '화면 열기' href 가 https://example.com/ 이 아님 (${href})`);
        if (text !== "화면 열기") problems.push(`[projects] orch-second 링크 글자가 '화면 열기' 가 아님 (${text})`);
        if (target !== "_blank" || !/noreferrer/.test(rel)) problems.push("[projects] '화면 열기' 링크가 새 탭(_blank, noreferrer)이 아님");
        if (inButton) problems.push("[projects] '화면 열기' 링크가 접기 버튼 안에 있음");
        if (!(await appLink.isVisible())) problems.push("[projects] '화면 열기' 링크가 보이지 않음");
      }
      if (await card.getByTestId("orch-app-link").count()) problems.push("[projects] 자기 저장소(orch-screens) 카드에 '화면 열기' 링크가 있음");

      // 연결 점검 줄(orch-connection): REPO 9/9(엔진 비교 없음), REPO2 빠짐 2·엔진 버전 다름(펼치면 항목·파일명), REPO3 는 404 → 빠짐 9·엔진 비교 표시 없음
      {
        const sum = async (c) => ((await c.getByTestId("orch-connection").locator(":scope > summary").textContent()) ?? "").replace(/\s+/g, " ").trim();
        const s1 = await sum(card);
        if (!s1.includes("연결 점검 9/9")) problems.push(`[projects] orch-screens 연결 점검 줄에 '연결 점검 9/9' 가 없음 (${s1})`);
        if (/빠짐|엔진 버전 다름|엔진 같음/.test(s1)) problems.push(`[projects] orch-screens(자기 저장소) 연결 점검 줄에 빠짐·엔진 비교 표시가 있음 (${s1})`);
        const s2 = await sum(second);
        for (const want of ["연결 점검 7/9", "빠짐 2", "엔진 버전 다름"]) if (!s2.includes(want)) problems.push(`[projects] orch-second 연결 점검 줄에 '${want}' 이 없음 (${s2})`);
        const conn2 = second.getByTestId("orch-connection");
        await conn2.locator(":scope > summary").click();
        for (const want of ["AGENTS.md", "wait.yml", "scripts/orch"]) {
          try { await conn2.getByText(want).first().waitFor({ state: "visible", timeout: 5000 }); }
          catch { problems.push(`[projects] orch-second 연결 점검을 펼쳐도 '${want}' 이 안 보임`); }
        }
        const s3 = await sum(page.getByTestId("orch-project-orch-third"));
        for (const want of ["연결 점검 0/9", "빠짐 9"]) if (!s3.includes(want)) problems.push(`[projects] orch-third 연결 점검 줄에 '${want}' 이 없음 (${s3})`);
        if (/엔진 버전 다름|엔진 같음/.test(s3)) problems.push(`[projects] orch-third 연결 점검 줄에 엔진 비교가 표시됨 (${s3})`);
      }

      // orch-third: compare 404(태그 prod-deployed 없음) → '바로 배포 · 완료 기록', ORCH_APP_URLS 항목 → '셋째화면 열기' 새 탭 링크
      {
        const third = page.getByTestId("orch-project-orch-third");
        const head3 = ((await third.getByTestId("orch-deploy-pending").textContent()) ?? "").replace(/\s+/g, " ").trim();
        if (!head3.startsWith("바로 배포 · 완료 기록")) problems.push(`[projects] orch-third 카드 머리가 '바로 배포 · 완료 기록' 이 아님 (${head3})`);
        const link3 = third.getByTestId("orch-app-link");
        if ((await link3.count()) !== 1) problems.push(`[projects] orch-third 카드에 ORCH_APP_URLS 링크가 1개가 아님 (${await link3.count()})`);
        else {
          const [href, target, rel, text] = [await link3.getAttribute("href"), await link3.getAttribute("target"), (await link3.getAttribute("rel")) ?? "", ((await link3.textContent()) ?? "").trim()];
          if (href !== "https://app.example.invalid/third") problems.push(`[projects] orch-third 링크 href 가 https://app.example.invalid/third 가 아님 (${href})`);
          if (text !== "셋째화면 열기") problems.push(`[projects] orch-third 링크 글자가 '셋째화면 열기' 가 아님 (${text})`);
          if (target !== "_blank" || !/noreferrer/.test(rel)) problems.push("[projects] orch-third 링크가 새 탭(_blank, noreferrer)이 아님");
          if (!(await link3.isVisible())) problems.push("[projects] orch-third 링크가 보이지 않음");
        }
      }

      // 진행 단계(roadmap.json phases): orch-second 는 P1 완료 + P2(ref 30, 끝난 run) 자동 완료 → '단계 2/4 완료', P3(ref 31, 구현 중) 자동 진행(굵게).
      // orch-screens 는 phases 가 없으므로 블록도 머리 문구도 없음(위 머리 요약 '남은 할 일 46과정 · 확인 필요 1' 그대로).
      {
        const flat2 = async (loc) => ((await loc.textContent()) ?? "").replace(/\s+/g, " ").trim();
        const head2 = await flat2(second.getByTestId("orch-project-summary"));
        if (!head2.startsWith("단계 2/6 완료 · 남은 할 일")) problems.push(`[projects] orch-second 카드 머리가 '단계 2/6 완료 · 남은 할 일 …' 이 아님 (${head2})`);
        if (await second.getByTestId("orch-phases").count()) problems.push("[projects] orch-second 카드에 옛 '진행 단계' 단독 블록이 남아 있음");
        // 줄을 모두 펼친다 (기본은 접힘)
        await second.locator("details[data-testid^='orch-stage-']").evaluateAll((els) => els.forEach((e) => { e.open = true; }));
        const group = (id) => second.locator(`[data-testid^="orch-phase-group-"][data-testid$="-${id}"]`);
        const rowOf = (loc) => loc.evaluate((el) => el.closest("details")?.getAttribute("data-testid") ?? null);
        const p3 = group("P3");
        if ((await p3.count()) !== 1) problems.push(`[projects] 개발 줄에 'P3' 묶음이 1개가 아님 (${await p3.count()})`);
        else {
          if ((await rowOf(p3)) !== "orch-stage-3") problems.push(`[projects] 'P3' 묶음이 개발 줄에 없음 (${await rowOf(p3)})`);
          if (!/font-semibold/.test((await p3.locator(":scope > p").getAttribute("class")) ?? "")) problems.push("[projects] 진행 중 단계 P3 머리가 굵게 표시되지 않음");
          const a = p3.locator(`a[href="https://github.com/${REPO2}/issues/31"]`);
          if ((await a.count()) !== 1) problems.push("[projects] 'P3' 묶음에 '#31' 링크가 없음");
          else {
            if (((await a.textContent()) ?? "").trim() !== "#31") problems.push("[projects] 'P3' 묶음 링크 글자가 '#31' 이 아님");
            if ((await a.getAttribute("target")) !== "_blank" || !/noreferrer/.test((await a.getAttribute("rel")) ?? "")) problems.push("[projects] '#31' 링크가 새 탭이 아님");
            const box = await a.boundingBox();
            if (!box || box.height < 44) problems.push(`[projects] '#31' 링크 터치 높이 ${box?.height}px < 44px`);
          }
        }
        const p4 = group("P4");
        if ((await p4.count()) !== 1) problems.push(`[projects] 'P4' 묶음이 1개가 아님 (${await p4.count()})`);
        else {
          if ((await p4.locator(`a[href="https://github.com/${REPO2}/issues/32"]`).count()) !== 1) problems.push("[projects] 'P4' 묶음에 '#32' 링크가 없음 (계획 JSON phase)");
          if (/font-semibold/.test((await p4.locator(":scope > p").getAttribute("class")) ?? "")) problems.push("[projects] 할 일 단계 P4 머리가 굵게 표시됨");
          if (((await p4.locator(":scope > p").textContent()) ?? "").includes("예정")) problems.push("[projects] item 이 있는 'P4' 묶음에 '예정' 이 있음");
        }
        const none = group("none");
        if ((await none.count()) !== 1) problems.push(`[projects] '단계 미지정' 묶음이 1개가 아님 (${await none.count()})`);
        else {
          if (!(await flat2(none.locator(":scope > p"))).startsWith("단계 미지정")) problems.push("[projects] 미지정 묶음 머리가 '단계 미지정' 이 아님");
          if ((await none.locator(`a[href="https://github.com/${REPO2}/issues/33"]`).count()) !== 1) problems.push("[projects] '단계 미지정' 묶음에 '#33' 링크가 없음");
        }
        const p5 = group("P5"), p6 = group("P6");
        if ((await p5.count()) !== 1 || (await p6.count()) !== 1) problems.push("[projects] 'P5'·'P6' 예정 묶음이 없음");
        else {
          if ((await rowOf(p5)) !== "orch-stage-2") problems.push(`[projects] 'P5' 묶음이 계획 줄에 없음 (${await rowOf(p5)})`);
          for (const [id, g] of [["P5", p5], ["P6", p6]]) if (!(await flat2(g.locator(":scope > p"))).includes("예정")) problems.push(`[projects] '${id}' 묶음 머리에 '예정' 이 없음`);
          const tt = await p5.getByTestId("orch-phase-tasks").locator("li").evaluateAll((els) => els.map((e) => (e.textContent ?? "").replace(/\s+/g, " ").trim()));
          if (tt.join("|") !== "나다섯째 직접 확인|AI다섯째 AI 정리") problems.push(`[projects] 'P5' tasks 가 '나 칩·AI 칩' 이 아님 (${tt.join("|")})`);
          if (await p6.getByTestId("orch-phase-tasks").count()) problems.push("[projects] tasks 없는 'P6' 에 tasks 목록이 있음");
        }
        const cell2 = await flat2(second.getByTestId("orch-cell-2"));
        if (!cell2.includes("2단계")) problems.push(`[projects] 계획 칸에 '2단계'(P5·P6)가 없음 (${cell2})`);
        const cell34 = (await flat2(second.getByTestId("orch-cell-3"))) + (await flat2(second.getByTestId("orch-cell-4")));
        if (!/[1-9]단계/.test(cell34)) problems.push(`[projects] 개발·통합 칸에 'n단계' 가 없음 (${cell34})`);
        const done = second.getByTestId("orch-stage-done");
        if ((await done.count()) !== 1) problems.push("[projects] '완료' 줄이 1개가 아님");
        else {
          const sum = await flat2(done.locator("summary"));
          if (!sum.startsWith("완료")) problems.push(`[projects] '완료' 줄 머리가 '완료' 로 시작하지 않음 (${sum})`);
          const order = await second.locator("details[data-testid^='orch-stage-']").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")).join());
          if (!order.startsWith("orch-stage-2,orch-stage-3,orch-stage-4,orch-stage-done")) problems.push(`[projects] '완료' 줄이 통합 줄 바로 아래가 아님 (${order})`);
          for (const [id, n] of [["P1", null], ["P2", 30]]) {
            const li = done.getByTestId(`orch-done-phase-${id}`);
            if ((await li.count()) !== 1) { problems.push(`[projects] '완료' 줄에 '${id}' 가 없음`); continue; }
            if (n && (await li.locator(`a[href="https://github.com/${REPO2}/issues/${n}"]`).count()) !== 1) problems.push(`[projects] '완료' 줄 '${id}' 에 '#${n}' 링크가 없음`);
          }
        }
        if (await card.getByTestId("orch-phases").count()) problems.push("[projects] phases 가 없는 orch-screens 카드에 '진행 단계' 블록이 있음");
        if (await card.locator("[data-testid^='orch-phase-group-'], [data-testid='orch-stage-done'], [data-testid^='orch-cell-phases-']").count()) problems.push("[projects] phases 가 없는 orch-screens 카드에 phase 묶음·완료 줄·'n단계' 가 있음");
        if ((await flat2(card.getByTestId("orch-project-summary"))).includes("단계 ")) problems.push("[projects] phases 가 없는 orch-screens 카드 머리에 '단계' 문구가 있음");
        for (const w of WIDTHS) {
          await page.setViewportSize({ width: w, height: 800 });
          await page.waitForTimeout(150);
          if (await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)) problems.push(`[projects-phases] ${w}x800 에서 가로 넘침`);
          const over = await second.getByTestId("orch-project-summary").evaluate((el) => el.scrollWidth > el.clientWidth);
          if (over) problems.push(`[projects-phases] ${w}px 에서 orch-second 카드 머리 요약 줄이 넘침`);
        }
        await second.scrollIntoViewIfNeeded();
        await page.setViewportSize({ width: 360, height: 800 });
        const file = path.join(OUT, "projects-phases-360.png");
        await second.screenshot({ path: file });
        shots.push(path.relative(ROOT, file));
        await page.setViewportSize({ width: 390, height: 844 });
      }

      // 카드 접기/펼치기: 머리 버튼(aria-expanded·aria-controls), 기본 펼침, 접어도 머리 줄(이름·남은 할 일·확인 필요)은 보임, 새로고침 뒤 유지
      const toggle = (c) => c.getByTestId("orch-project-toggle");
      const body = (c) => c.getByTestId("orch-project-body");
      const expanded = async (c) => toggle(c).getAttribute("aria-expanded");
      if ((await expanded(card)) !== "true" || (await expanded(second)) !== "true") problems.push("[projects] 프로젝트 카드 기본 상태가 펼침(aria-expanded=true)이 아님");
      {
        const ctl = await toggle(card).getAttribute("aria-controls");
        const bodyId = await body(card).getAttribute("id");
        if (!ctl || ctl !== bodyId) problems.push(`[projects] 접기 버튼 aria-controls(${ctl})가 카드 본문 id(${bodyId})와 다름`);
        const box = await toggle(card).boundingBox();
        if (!box || box.height < 44) problems.push(`[projects] 접기 버튼 높이 ${box?.height}px < 44px`);
      }
      const headText = ((await card.getByTestId("orch-project-summary").textContent()) ?? "").replace(/\s+/g, " ").trim();
      if (headText !== "남은 할 일 46과정 · 확인 필요 1") problems.push(`[projects] 카드 머리 요약이 '남은 할 일 46과정 · 확인 필요 1' 이 아님 (${headText})`);
      await toggle(card).click();
      try { await body(card).waitFor({ state: "hidden", timeout: 5000 }); } catch { problems.push("[projects] 카드 머리를 눌러도 본문이 숨겨지지 않음"); }
      if ((await expanded(card)) !== "false") problems.push(`[projects] 접은 뒤 aria-expanded 가 false 가 아님 (${await expanded(card)})`);
      if (!(await card.getByText("orch-screens", { exact: true }).first().isVisible()) || !(await card.getByTestId("orch-project-summary").isVisible()) || !(await card.getByTestId("orch-deploy-pending").isVisible()))
        problems.push("[projects] 접힌 카드 머리에 이름·남은 할 일·배포 대기가 안 보임");
      if (!(await body(second).isVisible())) problems.push("[projects] orch-screens 를 접었는데 orch-second 본문도 숨겨짐");
      const saved = await page.evaluate(() => localStorage.getItem("orch.projects.collapsed"));
      if (saved !== JSON.stringify(["example/orch-screens"])) problems.push(`[projects] localStorage 'orch.projects.collapsed' 값이 다름 (${saved})`);
      await page.reload();
      try {
        await toggle(card).waitFor({ timeout: 15000 });
        await page.waitForFunction(() => document.querySelector('[data-testid="orch-project-orch-screens"] [data-testid="orch-project-toggle"]')?.getAttribute("aria-expanded") === "false", null, { timeout: 5000 });
      } catch { problems.push(`[projects] 새로고침 뒤 접힘이 유지되지 않음 (aria-expanded=${await expanded(card).catch(() => "?")})`); }
      if (await body(card).isVisible()) problems.push("[projects] 새로고침 뒤 접힌 카드 본문이 보임");
      if ((await expanded(second)) !== "true") problems.push("[projects] 새로고침 뒤 orch-second 카드가 펼침이 아님");
      for (const w of WIDTHS) {
        await page.setViewportSize({ width: w, height: 800 });
        await page.waitForTimeout(150);
        if (await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)) problems.push(`[projects-collapsed] ${w}px 에서 가로 넘침`);
        const file = path.join(OUT, `projects-collapsed-${w}.png`);
        await page.screenshot({ path: file, fullPage: true });
        shots.push(path.relative(ROOT, file));
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await toggle(card).click();
      try { await body(card).waitFor({ state: "visible", timeout: 5000 }); } catch { problems.push("[projects] 접힌 카드 머리를 다시 눌러도 본문이 보이지 않음"); }
      if ((await expanded(card)) !== "true") problems.push(`[projects] 다시 펼친 뒤 aria-expanded 가 true 가 아님 (${await expanded(card)})`);
      if ((await page.evaluate(() => localStorage.getItem("orch.projects.collapsed"))) !== "[]") problems.push("[projects] 다시 펼친 뒤 localStorage 가 비지 않음");
    }
  }
  if (!SWITCH) {
    // 읽기 세션 (CONTROL_READ_TOKEN 토큰 교환): 값이 달라도 '모두 맞추기'·스위치·시간대 저장은 비활성
    const rctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "ko-KR" });
    const rpage = await rctx.newPage();
    rpage.on("pageerror", (e) => pageErrors.push(String(e)));
    await rpage.route("**/*", (r) => (r.request().url().startsWith(base) ? r.continue() : (external.push(r.request().url()), r.abort())));
    await rpage.goto(`${base}/agents`);
    const role = await rpage.evaluate(async (token) => {
      const r = await fetch("/api/session", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
      return (await r.json().catch(() => null))?.role ?? `HTTP ${r.status}`;
    }, readToken);
    if (role !== "read") problems.push(`[agents-read] 읽기 세션 로그인 실패 (${role})`);
    else {
      await rpage.reload();
      const main = page; // checkSwitchCard 는 page 를 쓰므로 잠시 바꿔 끼운다
      page = rpage;
      try {
        const sc = await checkSwitchCard("agents-read");
        if (sc) {
          if (!(await sc.align.count())) problems.push("[agents-read] '모두 맞추기' 버튼이 없음");
          else if (await sc.align.isEnabled()) problems.push("[agents-read] 읽기 세션에서 '모두 맞추기' 가 눌림 (비활성이어야 함)");
          for (const n of SWITCH_NAMES) if (await sc.sec.getByRole("switch", { name: n, exact: true }).isEnabled()) problems.push(`[agents-read] 읽기 세션에서 '${n}' 스위치가 눌림`);
          if (await sc.sec.getByRole("button", { name: "저장", exact: true }).isEnabled()) problems.push("[agents-read] 읽기 세션에서 작업 시간대 '저장' 이 눌림");
          if (!(await sc.sec.getByText("관리자 로그인에서만 바꿀 수 있습니다.").count())) problems.push("[agents-read] '관리자 로그인에서만 바꿀 수 있습니다.' 안내가 없음");
        }
        const file = path.join(OUT, "agents-read-390.png");
        fs.mkdirSync(OUT, { recursive: true });
        await rpage.screenshot({ path: file, fullPage: true });
        shots.push(path.relative(ROOT, file));
      } finally { page = main; }
    }
    await rctx.close();
  } else {
    // 쓰기 시나리오: 관리자 로그인 → AI 팀 탭 → Codex 토글 (기준 orch-screens 가 off → on 으로 모든 프로젝트에 저장)
    // ok 시나리오는 그 사이 다른 곳에서 작업 시간대가 바뀐 것으로 두어, 저장 뒤 다시 읽을 때 시간대 입력값도 갱신되는지 본다.
    await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("link", { name: /AI 팀/ }).click();
    await page.waitForURL((u) => u.pathname.startsWith("/agents"));
    const sc = await checkSwitchCard(`switch-${SWITCH}`);
    if (sc) {
      const before = ghCalls.length;
      const win = sc.sec.locator("input#win-all");
      if ((await win.inputValue()) !== "") problems.push(`[switch-${SWITCH}] 처음 작업 시간대 입력이 비어 있지 않음 (${await win.inputValue()})`);
      if (SWITCH === "ok") for (const r of [REPO, REPO2, REPO3, REPO4]) setVar(r, "ORCH_WINDOW", "09:00-21:00"); // 화면이 읽은 뒤 바뀐 기준값
      await sc.sec.getByRole("switch", { name: "Codex (독립 검수)" }).click();
      const msg = sc.sec.getByTestId("orch-switch-msg");
      try { await msg.waitFor({ timeout: 15000 }); } catch { problems.push(`[switch-${SWITCH}] 저장 결과 문구가 나오지 않음`); }
      const text = ((await msg.textContent().catch(() => "")) ?? "").trim();
      const cls = (await msg.getAttribute("class").catch(() => "")) ?? "";
      if (SWITCH === "ok") {
        if (text !== "4개 프로젝트에 적용") problems.push(`[switch-ok] 결과 문구가 '4개 프로젝트에 적용' 이 아님 (${text})`);
        if (/text-warn/.test(cls)) problems.push("[switch-ok] 전체 성공 문구가 warn 색");
      } else {
        if (!text.startsWith("일부 실패: orch-second · ")) problems.push(`[switch-partial] 결과 문구가 '일부 실패: orch-second · …' 이 아님 (${text})`);
        if (/프로젝트에 적용/.test(text)) problems.push(`[switch-partial] 일부 실패인데 전체 성공 문구가 보임 (${text})`);
        if (!/text-warn/.test(cls)) problems.push("[switch-partial] 일부 실패 문구가 warn 색이 아님");
      }
      const writes = ghCalls.slice(before).filter((c) => !c.startsWith("GET"));
      const want = [`PATCH /repos/${REPO}/actions/variables/ORCH_CODEX`, `POST /repos/${REPO}/actions/workflows/orchestrator.yml/dispatches`, `PATCH /repos/${REPO2}/actions/variables/ORCH_CODEX`, `PATCH /repos/${REPO3}/actions/variables/ORCH_CODEX`, `PATCH /repos/${REPO4}/actions/variables/ORCH_CODEX`];
      if (SWITCH === "ok") for (const r of [REPO2, REPO3, REPO4]) want.push(`POST /repos/${r}/actions/workflows/orchestrator.yml/dispatches`);
      for (const w of want) if (!writes.includes(w)) problems.push(`[switch-${SWITCH}] 가짜 GitHub 에 '${w}' 가 없음 (${writes.join(", ")})`);
      if (SWITCH === "partial" && writes.some((w) => w.startsWith(`POST /repos/${REPO2}/actions/workflows`))) problems.push("[switch-partial] 저장 실패한 저장소에 dispatch 를 보냄");
      if (!ghCalls.slice(before).some((c) => c.startsWith(`GET /repos/${REPO}/actions/variables`))) problems.push(`[switch-${SWITCH}] 저장 뒤 다시 읽지 않음`);
      // 다시 읽은 뒤: Codex 는 기준 값(ON), ok 는 시간대 입력도 새 기준값으로 갱신
      try { await page.waitForFunction(() => document.querySelector('[data-testid="orch-switches"] [role="switch"][aria-label="Codex (독립 검수)"]')?.getAttribute("aria-checked") === "true", null, { timeout: 10000 }); }
      catch { problems.push(`[switch-${SWITCH}] 다시 읽은 뒤 Codex 가 ON 이 아님`); }
      if (SWITCH === "ok") {
        try { await page.waitForFunction(() => document.querySelector("input#win-all")?.value === "09:00-21:00", null, { timeout: 10000 }); }
        catch { problems.push(`[switch-ok] 기준값이 바뀌었는데 작업 시간대 입력이 갱신되지 않음 (${await win.inputValue()})`); }
      }
      for (const w of WIDTHS) {
        await page.setViewportSize({ width: w, height: 844 });
        await page.waitForTimeout(150);
        if (await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)) problems.push(`[switch-${SWITCH}] ${w}px 에서 가로 넘침`);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await sc.sec.scrollIntoViewIfNeeded();
      fs.mkdirSync(OUT, { recursive: true });
      const file = path.join(OUT, `switch-${SWITCH}.png`);
      await page.screenshot({ path: file, fullPage: true });
      shots.push(path.relative(ROOT, file));
    }
  }
  if (pageErrors.length) problems.push(`페이지 오류: ${pageErrors.slice(0, 3).join(" | ")}`);
  if (external.length) problems.push(`외부 요청 차단됨: ${[...new Set(external)].slice(0, 3).join(", ")}`);
  if (!SWITCH && ghCalls.some((c) => c.startsWith("POST") || c.startsWith("PATCH"))) problems.push(`화면 조회 중 GitHub 쓰기 요청: ${ghCalls.filter((c) => !c.startsWith("GET")).join(", ")}`);
  if (SWITCH) {
    const allowed = /^(PATCH \/repos\/[^/]+\/[^/]+\/actions\/variables\/ORCH_CODEX|POST \/repos\/[^/]+\/[^/]+\/actions\/workflows\/orchestrator\.yml\/dispatches)$/;
    const odd = ghCalls.filter((c) => !c.startsWith("GET") && !allowed.test(c));
    if (odd.length) problems.push(`쓰기 시나리오에서 예상 밖 GitHub 쓰기: ${odd.join(", ")}`);
  }
} catch (e) {
  problems.push(`실행 실패: ${e?.message ?? e}`);
  try { problems.push(`server.log 끝: ${fs.readFileSync(path.join(tmp, "server.log"), "utf8").slice(-800)}`); } catch {}
} finally {
  await browser?.close().catch(() => {});
  app.kill("SIGTERM");
  proxy.close(); ghServer.close();
}

const report = [`## 결과 화면 테스트 (Playwright)`, "", problems.length ? `❌ 실패 ${problems.length}건` : SWITCH ? `✅ 통과 · 스위치 쓰기 시나리오 ${SWITCH}` : `✅ 통과 · 탭 5개 × 폭 ${WIDTHS.join("/")}px`, "",
  ...problems.map((p) => `- ${p}`), problems.length ? "" : "", `스크린샷 ${shots.length}장: ${path.relative(ROOT, OUT) || "."}/`].join("\n");
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + "\n");
process.exit(problems.length ? 1 : 0);
