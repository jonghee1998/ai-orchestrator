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
import { githubFixtures, REPO, REPO2 } from "./fixtures.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.resolve(process.env.SCREENS_DIR || path.join(ROOT, ".screens"));
const WIDTHS = [360, 390, 430];
const CURRENT_VERSION = /version: "(\d+\.\d+\.\d+)"/.exec(fs.readFileSync(path.join(ROOT, "src/lib/patchnotes.ts"), "utf8"))?.[1];

const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const listen = (srv) => new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok(srv.address().port)));

// ---- fake GitHub API
const gh = githubFixtures(new Date());
const ghCalls = [];
const ghServer = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  ghCalls.push(`${req.method} ${url.pathname}${url.search}`);
  const hit = gh(req.method, url);
  res.writeHead(hit ? hit.status : 404, { "content-type": "application/json" });
  res.end(hit?.body === undefined ? JSON.stringify({ message: "Not Found" }) : JSON.stringify(hit.body));
});
const ghPort = await listen(ghServer);

// ---- app (real build) with throwaway admin credentials
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "screens-"));
const user = `u${crypto.randomBytes(8).toString("hex")}`, password = crypto.randomBytes(18).toString("hex");
const salt = crypto.randomBytes(16);
const key = crypto.scryptSync(password, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
const appPort = await freePort();
const log = fs.openSync(path.join(tmp, "server.log"), "w");
const app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(appPort)], {
  cwd: ROOT,
  stdio: ["ignore", log, log],
  env: {
    PATH: process.env.PATH, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", VERCEL_ENV: "preview",
    ADMIN_USERNAME: user, ADMIN_PASSWORD_HASH: `scrypt$131072$8$1$${salt.toString("hex")}$${key.toString("hex")}`,
    CONTROL_ADMIN_TOKEN: crypto.randomBytes(24).toString("hex"),
    ORCH_REPOS: [REPO, REPO2].join(","), ORCH_GITHUB_TOKEN: "fixture-token", ORCH_GITHUB_API: `http://127.0.0.1:${ghPort}`,
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
  const page = await context.newPage();
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
    { name: "architecture", path: "/architecture", nav: "구조", expect: ["아키텍처", "배포 · 비밀값", "보조 도구", "Impeccable", "Playwright"], forbid: [] },
    { name: "patch-notes", path: "/patch-notes", nav: "패치노트", expect: [`v${CURRENT_VERSION}`, "ai-orchestrator", "v2.x", "v1.x", "새 디자인과 전체 흐름"], forbid: [] },
  ];
  const navLabels = (await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("link").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
  for (const t of TABS) if (!navLabels.some((l) => l.includes(t.nav))) problems.push(`하단 탭에 '${t.nav}' 없음 (${navLabels.join(", ")})`);

  for (const t of TABS) {
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
    if (t.name === "projects") {
      // '지금 일하는 AI' 카드: 제목, 네 줄 이름, 두 저장소에 걸친 예시 작업 (구현 중 · 검수 중 · 승인 대기 · 쉬는 중)
      const agentsCard = page.getByTestId("orch-agents");
      const text1 = async (loc) => ((await loc.textContent()) ?? "").replace(/\s+/g, " ").trim();
      const agentsText = await text1(agentsCard);
      if (!(await page.getByRole("heading", { name: "지금 일하는 AI" }).count())) problems.push("[projects] '지금 일하는 AI' 제목이 없음");
      for (const [id, name, wants] of [
        ["sonnet", "Sonnet", ["orch-screens", "#11", "상황판 시험 작업", "Step 2/3", "구현 중", "orch-second", "#31", "둘째저장소 구현 작업", "Step 1/2"]],
        ["opus", "Opus", ["쉬는 중"]],
        ["codex", "Codex", ["orch-second", "#32", "둘째저장소 검수 작업", "Step 2/2", "검수 중"]],
        ["user", "사용자", ["#12", "승인 대기 시험 작업", "#33", "둘째저장소 승인 작업", "반영 승인 대기"]],
      ]) {
        const t = await text1(page.getByTestId(`orch-agent-${id}`));
        if (!t.startsWith(name)) problems.push(`[projects] '지금 일하는 AI' ${name} 줄이 없음 (${t.slice(0, 80)})`);
        for (const want of wants) if (!t.includes(want)) problems.push(`[projects] '지금 일하는 AI' ${name} 줄에 '${want}' 이 없음 (${t.slice(0, 200)})`);
      }
      if (!agentsText.includes("쉬는 중")) problems.push("[projects] '지금 일하는 AI' 에 '쉬는 중' 이 없음");
      if (!(await agentsCard.locator('a[href$="/issues/31"][target="_blank"]').count())) problems.push("[projects] '지금 일하는 AI' #31 Issue 링크가 없음");
      // 기본 상태: 인프라·확장 목록, 단계 줄 4개, 작업 항목 모두 접힘 (줄의 요약·개수만 보임).
      for (const hidden of ["로드맵시험 저장소", "확장시험 두번째 저장소", "알파공정 2단계 제목", "알파공정 3단계 확인항목", "3.10 독립 검수", "알림 모아보기", "승인 기다리는 시험 계획", "상황판 시험 작업", "전체 39과정 중", "개발 여부를 정함"]) {
        // 프로젝트 카드 안에서만 검사한다: 맨 위 '지금 일하는 AI' 카드는 작업 제목(예: 상황판 시험 작업)을 일부러 보여준다.
        if (await page.locator('[data-testid^="orch-project-"]').getByText(hidden).first().isVisible()) problems.push(`[projects] 접힌 내용 '${hidden}' 이 기본 상태에서 보임`);
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
    if (t.name === "projects") {
      const card = page.getByTestId("orch-project-orch-screens"); // 저장소가 둘이므로 단계 줄·로드맵은 첫 카드 안에서만 찾는다
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
    }
  }
  if (pageErrors.length) problems.push(`페이지 오류: ${pageErrors.slice(0, 3).join(" | ")}`);
  if (external.length) problems.push(`외부 요청 차단됨: ${[...new Set(external)].slice(0, 3).join(", ")}`);
  if (ghCalls.some((c) => c.startsWith("POST") || c.startsWith("PATCH"))) problems.push(`화면 조회 중 GitHub 쓰기 요청: ${ghCalls.filter((c) => !c.startsWith("GET")).join(", ")}`);
} catch (e) {
  problems.push(`실행 실패: ${e?.message ?? e}`);
  try { problems.push(`server.log 끝: ${fs.readFileSync(path.join(tmp, "server.log"), "utf8").slice(-800)}`); } catch {}
} finally {
  await browser?.close().catch(() => {});
  app.kill("SIGTERM");
  proxy.close(); ghServer.close();
}

const report = [`## 결과 화면 테스트 (Playwright)`, "", problems.length ? `❌ 실패 ${problems.length}건` : `✅ 통과 · 탭 5개 × 폭 ${WIDTHS.join("/")}px`, "",
  ...problems.map((p) => `- ${p}`), problems.length ? "" : "", `스크린샷 ${shots.length}장: ${path.relative(ROOT, OUT) || "."}/`].join("\n");
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + "\n");
process.exit(problems.length ? 1 : 0);
