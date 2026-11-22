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
import { githubFixtures, REPO } from "./fixtures.mjs";

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
    ORCH_REPOS: REPO, ORCH_GITHUB_TOKEN: "fixture-token", ORCH_GITHUB_API: `http://127.0.0.1:${ghPort}`,
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
    { name: "projects", path: "/projects", nav: "프로젝트", expect: ["0 인프라", "작업 흐름", "3 개발", "상황판 시험 작업", "구현 중 · Step 2/3", "반영 승인 대기", "승인 기다리는 시험 계획", "알림 모아보기", "다음 배포까지 3/10", "6 확장", "작업 기록은 패치노트 탭"], forbid: ["설정되지 않았습니다", "끝난 시험 작업", "로드맵 없음", "로드맵 읽기 실패"] },
    { name: "agents", path: "/agents", nav: "AI 팀", expect: ["AI 사용량", "42% 사용", "AI ON/OFF"], forbid: ["확인 불가"] },
    { name: "briefing", path: "/briefing", nav: "PM 브리핑", expect: ["결정 필요", "승인 대기 시험 작업", "orch-screens #12", "승인 대기 계획", "승인 기다리는 시험 계획", "감사 OK 2/3", "아이디어함", "상황판 채팅", "알림 모아보기", "묻고 답하는 흐름을 먼저 붙이면 효과가 큽니다", "의견 수집 중", "아이디어 적기"], forbid: ["승인 대기 계획 없음"] },
    { name: "architecture", path: "/architecture", nav: "구조", expect: ["아키텍처", "보조 도구", "Impeccable", "Playwright"], forbid: [] },
    { name: "patch-notes", path: "/patch-notes", nav: "패치노트", expect: [`v${CURRENT_VERSION}`, "오케스트레이터 엔진"], forbid: [] },
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
      // 아이디어함: 저장소 1개라 프로젝트 칩 줄은 숨김, 관리자에게 입력창(항목·내 의견·등록)이 보임. 등록은 누르지 않는다 (읽기 전용).
      if (await page.getByRole("group", { name: "프로젝트 필터" }).count()) problems.push("[briefing] 프로젝트가 1개인데 필터 칩 줄이 보임");
      for (const [label, el] of [["항목", page.getByLabel("항목", { exact: false })], ["내 의견", page.getByLabel("내 의견", { exact: false })], ["등록", page.getByRole("button", { name: "등록", exact: true })]]) {
        try { await el.first().waitFor({ state: "visible", timeout: 5000 }); } catch { problems.push(`[briefing] 아이디어 입력창의 '${label}' 가 보이지 않음`); }
      }
      // 날짜는 요일 형식 (예: 11/21(토) 14:00 KST)
      const dates = await page.locator('article[data-testid^="orch-idea-"]').first().innerText();
      if (!/\d{1,2}\/\d{1,2}\([월화수목금토일]\) \d{2}:\d{2} KST/.test(dates)) problems.push(`[briefing] 아이디어 카드 날짜가 요일 형식이 아님: ${JSON.stringify(dates.slice(0, 200))}`);
      if (!(await page.locator('a[href$="/issues/21"]').count())) problems.push("[briefing] 아이디어(#21) '원문 보기' 링크가 없음");
    }
    if (t.name === "projects") {
      // 기본 상태: 인프라·작업 줄·흐름 보기·확장 모두 접힘
      for (const hidden of ["로드맵시험 저장소", "확장시험 두번째 저장소", "알파공정 2단계 제목", "알파공정 3단계 확인항목", "독립 검수"]) {
        if (await page.getByText(hidden).first().isVisible()) problems.push(`[projects] 접힌 내용 '${hidden}' 이 기본 상태에서 보임`);
      }
      if (!(await page.getByText("진행 중 2개").first().isVisible())) problems.push("[projects] '진행 중 2개' 가 보이지 않음");
      // implementing run(#11) 줄: 강조된 단계 칩이 '3 개발', 세부 위치 '3.7'
      const runRow = page.getByTestId("orch-run-orch-screens-11");
      const current = (await runRow.locator('[aria-current="step"]').allInnerTexts()).map((t) => t.trim());
      if (current.join() !== "3 개발") problems.push(`[projects] #11 작업 줄의 강조 칩이 '3 개발' 이 아님 (${current.join(",")})`);
      if (!/3\.7 구현 중/.test(await runRow.innerText())) problems.push("[projects] #11 작업 줄에 '3.7 구현 중' 이 없음");
      // 0 인프라 ✅ 1/3 (완료 1개 / 3개), 6 확장 0/1 (na 제외)
      const setupLine = (await page.getByTestId("orch-roadmap-setup").locator("summary").innerText()).replace(/\s+/g, " ");
      if (!/0 인프라 ✅ 1\/3/.test(setupLine)) problems.push(`[projects] 인프라 줄이 '0 인프라 ✅ 1/3' 이 아님 (${setupLine})`);
      const expLine = (await page.getByTestId("orch-roadmap-expansion").locator("summary").innerText()).replace(/\s+/g, " ");
      if (!/6 확장 0\/1/.test(expLine)) problems.push(`[projects] 확장 줄이 '6 확장 0/1' 이 아님 (${expLine})`);
      // 위치 순(5→1): 반영 승인 대기(4.7) → 구현 중(3.7) → 계획(2.8) → 아이디어(1.3)
      const order = await page.getByTestId("orch-flow").locator('[data-testid^="orch-run-"], [data-testid^="orch-plan-"], [data-testid^="orch-idea-"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
      if (order.join() !== "orch-run-orch-screens-12,orch-run-orch-screens-11,orch-plan-orch-screens-13,orch-idea-orch-screens-22") problems.push(`[projects] 작업 흐름 순서가 5→1 이 아님 (${order.join(",")})`);
      // 기본 상태 높이: 360x800 에서 첫 프로젝트 카드 600px 이하
      await page.setViewportSize({ width: 360, height: 800 });
      await page.waitForTimeout(150);
      const cardH = await page.getByTestId("orch-project-orch-screens").evaluate((el) => (el.parentElement ?? el).getBoundingClientRect().height);
      console.log(`projects: 첫 프로젝트 카드 높이 ${Math.round(cardH)}px (360x800, 모두 접힘)`);
      if (cardH > 600) problems.push(`[projects] 360x800 에서 첫 프로젝트 카드 높이 ${Math.round(cardH)}px > 600px`);
      await page.setViewportSize({ width: 390, height: 844 });
      // 'PM에게 말하기' 바로가기: 새 창 링크
      const pmLink = page.getByRole("link", { name: "PM에게 말하기" });
      if (!(await pmLink.isVisible())) problems.push("[projects] 'PM에게 말하기' 링크가 보이지 않음");
      else if ((await pmLink.getAttribute("target")) !== "_blank" || !/noreferrer/.test((await pmLink.getAttribute("rel")) ?? "") || !/^https?:\/\//.test((await pmLink.getAttribute("href")) ?? "")) problems.push("[projects] 'PM에게 말하기' 링크가 새 창(_blank, noreferrer, http 주소)이 아님");
      // 새로고침 버튼: 보이고, 누르면(GET 만 발생) '방금 갱신' 시각이 나와야 함
      const refreshBtn = page.getByRole("button", { name: "↻ 새로고침" });
      if (!(await refreshBtn.isVisible())) problems.push("[projects] '↻ 새로고침' 버튼이 보이지 않음");
      else {
        await refreshBtn.click();
        try { await page.getByText("방금 갱신", { exact: false }).first().waitFor({ state: "visible", timeout: 10000 }); }
        catch { problems.push("[projects] 새로고침을 눌러도 '방금 갱신' 이 안 보임"); }
      }
    }
    for (const text of t.forbid) if (await page.getByText(text, { exact: false }).count()) problems.push(`[${t.name}] '${text}' 가 보임`);
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
      // 펼친 상태: 인프라 항목 · 확장 항목 · 흐름 보기 · 작업 줄(현재 스텝은 펼침) · 대기 스텝
      const expand = async (summary, shown, what) => {
        await summary.click();
        try { await page.getByText(shown).first().waitFor({ state: "visible", timeout: 5000 }); }
        catch { problems.push(`[projects] ${what} 를 펼쳐도 '${shown}' 이 안 보임`); }
      };
      await expand(page.getByTestId("orch-roadmap-setup").locator("summary"), "0.1 로드맵시험 저장소", "'0 인프라'");
      for (const item of ["0.2 로드맵시험 배포", "0.3 로드맵시험 알림"]) {
        if (!(await page.getByText(item).first().isVisible())) problems.push(`[projects] 인프라를 펼쳐도 '${item}' 이 안 보임`);
      }
      await expand(page.getByTestId("orch-roadmap-expansion").locator("summary"), "6.1 확장시험 두번째 저장소", "'6 확장'");
      await expand(page.getByTestId("orch-lifecycle").locator("summary"), "독립 검수", "'흐름 보기'");
      await expand(page.getByTestId("orch-run-orch-screens-11").locator("summary"), "알파공정 2단계 확인항목", "#11 작업 줄");
      for (const text of ["스텝 1/3 통과", "지금 2번"]) {
        if (!(await page.getByText(text).first().isVisible())) problems.push(`[projects] #11 작업 줄을 펼쳐도 '${text}' 이 안 보임`);
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
