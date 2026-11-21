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
    { name: "projects", path: "/projects", nav: "프로젝트", expect: ["상황판 시험 작업", "구현 중", "스텝 1/3 통과", "지금 2번", "알파공정 2단계 제목", "알파공정 2단계 확인항목"], forbid: ["설정되지 않았습니다"] },
    { name: "agents", path: "/agents", nav: "AI 팀", expect: ["AI 사용량", "42% 사용", "AI ON/OFF"], forbid: ["확인 불가"] },
    { name: "briefing", path: "/briefing", nav: "PM 브리핑", expect: ["결정 필요", "승인 대기 시험 작업", "orch-screens #12", "승인 대기 계획", "승인 기다리는 시험 계획", "감사 OK 2/3"], forbid: ["승인 대기 계획 없음"] },
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
    if (t.name === "projects") {
      // 기본 상태: 현재 스텝은 펼침, 대기 스텝(3번)·끝난 작업은 접힘
      if (await page.getByText("알파공정 3단계 확인항목").isVisible()) problems.push("[projects] 대기 스텝의 할 일이 기본 상태에서 보임");
      if (await page.getByText("끝난 시험 작업").isVisible()) problems.push("[projects] 끝난 작업이 기본 상태에서 보임");
      if (!(await page.getByText("진행 중 2개").first().isVisible())) problems.push("[projects] '진행 중 2개' 가 보이지 않음");
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
      // 펼친 상태: 끝난 작업 묶음 + 대기 스텝
      await page.getByText("끝난 작업 1개").click();
      try { await page.getByText("끝난 시험 작업").first().waitFor({ state: "visible", timeout: 5000 }); }
      catch { problems.push("[projects] '끝난 작업 1개' 를 눌러도 '끝난 시험 작업' 이 안 보임"); }
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
