import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { PATCH_NOTES } from "../patchnotes";
import { AGENT_ORDER, type AgentId } from "./agents";
import { FLAG_KEYS, type FlagKey } from "./model";

const ROOT = process.cwd();
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), "utf8");
const lines = (s: string): string[] => s.split("\n");

/** `start` 로 시작하는 줄부터 `endPrefix` 로 시작하는 다음 줄 전까지. 못 찾으면 null. */
function section(text: string, start: string, endPrefix: string): string | null {
  const ls = lines(text);
  const i = ls.findIndex((l) => l.startsWith(start));
  if (i < 0) return null;
  let j = ls.findIndex((l, k) => k > i && l.startsWith(endPrefix));
  if (j < 0) j = ls.length;
  return ls.slice(i, j).join("\n");
}

const NEW_PROJECT = (): string => read("docs/NEW_PROJECT.md");
const engineSection = (): string | null => section(NEW_PROJECT(), "2. **엔진 설치**", "3. **");
const chapter = (n: number, next: number): string | null => section(NEW_PROJECT(), `## ${n}.`, `## ${next}.`);

test("docs A: NEW_PROJECT 엔진 설치 구간의 워크플로 목록 = .github/workflows (ci.yml 제외)", () => {
  const actual = fs.readdirSync(path.join(ROOT, ".github/workflows"))
    .filter((f) => /\.ya?ml$/.test(f) && f !== "ci.yml");
  assert.ok(actual.length > 0, "실제 워크플로 목록이 비어 있음");
  const sec = engineSection();
  assert.ok(sec, "NEW_PROJECT.md에서 '2. **엔진 설치**' 구간을 찾지 못함");
  const documented = [...new Set([...sec.matchAll(/`([^`\s/]+\.ya?ml)`/g)].map((m) => m[1]))].filter((f) => f !== "ci.yml");
  const missing = actual.filter((f) => !documented.includes(f));
  const extra = documented.filter((f) => !actual.includes(f));
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] }, `문서에 없음: ${missing.join(", ")} / 실제로 없음: ${extra.join(", ")}`);
});

test("docs B: ORCH_MANUAL auto_merge 행·워크플로 개수·자동 모드 2번", () => {
  const doc = read("docs/ORCH_MANUAL.md");
  const rows = lines(doc).filter((l) => l.startsWith("| `auto_merge` |"));
  assert.equal(rows.length, 1);
  assert.ok(rows[0].includes("ORCH_AUTO"));
  assert.ok(!doc.includes("워크플로 4개"));
  const sec = section(doc, "### 자동 모드", "### ") ?? section(doc, "### 자동 모드", "## ");
  assert.ok(sec, "자동 모드 절을 찾지 못함");
  const two = lines(sec).filter((l) => l.startsWith("2. **수정 필요**"));
  assert.equal(two.length, 1);
  assert.ok(two[0].includes("기존 계획"));
  assert.ok(two[0].includes("마지막 라운드 전"));
});

test("docs C: PM_HANDOFF auto_merge: false 줄은 자동 모드를 언급", () => {
  const hit = lines(read("docs/PM_HANDOFF.md")).filter((l) => l.includes("auto_merge: false"));
  assert.ok(hit.length > 0);
  for (const l of hit) assert.ok(l.includes("ORCH_AUTO") || l.includes("자동 모드"), l);
});

test("docs D: NEW_PROJECT 엔진 설치 구간(head SHA·VERCEL_DEPLOY_HOOK)과 4장(ORCH_AUTO·BOT_PAT)", () => {
  const sec = engineSection();
  assert.ok(sec);
  assert.ok(sec.includes("head SHA"));
  assert.ok(sec.includes("VERCEL_DEPLOY_HOOK"));
  const ch4 = chapter(4, 5) ?? section(NEW_PROJECT(), "## 4.", "## 5.");
  assert.ok(ch4, "4장을 찾지 못함");
  assert.ok(ch4.includes("ORCH_AUTO"));
  assert.ok(ch4.includes("BOT_PAT"));
});

test("docs E: NEW_PROJECT 8번 스위치 초기화에 ORCH_AUTO·ORCH_CODEX_DEV·ORCH_FABLE", () => {
  const l = lines(NEW_PROJECT()).filter((x) => x.startsWith("8. **스위치 초기화**"));
  assert.equal(l.length, 1);
  assert.ok(l[0].includes("ORCH_AUTO"));
  assert.ok(l[0].includes("ORCH_CODEX_DEV"));
  assert.ok(l[0].includes("ORCH_FABLE"));
  assert.ok(l[0].includes("ORCH_FABLE`는 기본이 on"));
});

test("docs F: NEW_PROJECT 1장 9번 main 보호·끝난 기준", () => {
  const ch1 = section(NEW_PROJECT(), "## 1.", "## 2.");
  assert.ok(ch1, "1장을 찾지 못함");
  const nine = lines(ch1).filter((l) => l.startsWith("9. **main 보호"));
  assert.equal(nine.length, 1);
  assert.ok(nine[0].includes("필수 검사"));
  assert.ok(nine[0].includes("SECURITY_CHECKLIST.md"));
  const done = lines(ch1).filter((l) => l.startsWith("- **끝난 기준**"));
  assert.equal(done.length, 1);
  assert.ok(done[0].includes("필수 검사"));
});

test("docs G: ORCH_MANUAL 운영 배포 절은 first-parent 기준·단계별 확인 안내", () => {
  const sec = section(read("docs/ORCH_MANUAL.md"), "## 운영 배포", "## ");
  assert.ok(sec, "'## 운영 배포' 절을 찾지 못함");
  assert.ok(sec.includes("--first-parent"));
  for (const bad of ["머지된 수입니다", "머지 대기", "업데이트(머지)", "마지막으로 배포한 커밋"]) {
    assert.ok(!sec.includes(bad), `운영 배포 절에 '${bad}' 가 남아 있음`);
  }
  const one = (prefix: string): string => {
    const hit = lines(sec).filter((l) => l.startsWith(prefix));
    assert.equal(hit.length, 1, `'${prefix}' 로 시작하는 줄이 정확히 1개가 아님`);
    return hit[0];
  };
  const base = one("- 기준점:");
  for (const k of ["prod-deployed", "--first-parent"]) assert.ok(base.includes(k), `기준점 줄에 ${k} 없음`);
  const card = one("- 프로젝트 카드 머리의 배포 문구");
  for (const k of [
    "404", "대기가 0", "배포 완료", "배포 대기 ?",
    "`prod-deployed...main`", "404 또는 기준점 뒤 대기가 0이면 '배포 완료'", "404 이외", "기본 브랜치", "main 브랜치가 없",
    "404로 답할 때", "`total_commits`", "250개 이상", "배포 대기 250", "Deployments", "Actions",
  ]) assert.ok(card.includes(k), `카드 문구 줄에 ${k} 없음`);
  for (const phrase of [
    "404 이외의 오류(403·500 등)나 읽기 실패는 '배포 대기 ?'",
    "`total_commits`가 받은 커밋 수와 다르면(250개에서 잘린 경우 포함) '배포 대기 ?'",
    "`total_commits` 없이 커밋이 250개 이상 오면 '배포 대기 ?'",
    "한 줄로 이어진(단일 체인) 커밋 250개가 `total_commits` 250과 함께 모두 오면 '배포 대기 250'",
  ]) assert.ok(card.includes(phrase), `카드 문구 줄에 '${phrase}' 없음`);
  assert.ok(!card.includes("250개 초과"), "카드 문구 줄에 옛 문구 '250개 초과' 가 남아 있음");
  const req = one("- 배포 요청 확인:");
  for (const k of ["Actions", "`deploy`", "Trigger Vercel deploy hook"]) assert.ok(req.includes(k), `배포 요청 확인 줄에 ${k} 없음`);
  assert.ok(!req.includes("prod-deployed"), "배포 요청 확인 줄에 태그 이야기가 있음");
  const tag = one("- 기준 갱신 확인:");
  for (const k of ["Remember deployed commit", "prod-deployed"]) assert.ok(tag.includes(k), `기준 갱신 확인 줄에 ${k} 없음`);
  const build = one("- 빌드 확인:");
  for (const k of ["Vercel", "Deployments"]) assert.ok(build.includes(k), `빌드 확인 줄에 ${k} 없음`);
});

test("docs H: PM_HANDOFF 현재 상태의 상황판 버전은 PATCH_NOTES 에 있고 2.8.4 이상", () => {
  const sec = section(read("docs/PM_HANDOFF.md"), "## 현재 상태", "## ");
  assert.ok(sec, "'## 현재 상태' 절을 찾지 못함");
  const m = sec.match(/상황판 v(\d+\.\d+\.\d+)/);
  assert.ok(m, "현재 상태에 '상황판 vX.Y.Z' 가 없음");
  const v = m[1];
  assert.ok(PATCH_NOTES.some((n) => n.version === v), `PATCH_NOTES 에 ${v} 가 없음`);
  const num = (s: string): number[] => s.split(".").map(Number);
  const [a, b] = [num(v), num("2.8.4")];
  const cmp = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  assert.ok(cmp >= 0, `${v} 는 2.8.4 보다 낮음`);
});

test("docs I: ORCH_MANUAL 10장 프로젝트 행은 지금 카드 화면 기준", () => {
  const sec = section(read("docs/ORCH_MANUAL.md"), "## 10.", "## ");
  assert.ok(sec, "10장을 찾지 못함");
  const cond = "단계 묶음('단계 미지정' 제외)이 하나 이상 있을 때만";
  const rows = lines(sec).filter((l) => l.startsWith("| 프로젝트 |"));
  assert.equal(rows.length, 1, "'| 프로젝트 |' 줄이 정확히 1개가 아님");
  const row = rows[0];
  for (const k of [
    "완료 기록", "패치노트", "배포 완료", "배포 대기", "인프라", "확장", "계획", "개발", "통합",
    "추가 검토", "확인 필요", "남은 할 일 없음", "열기", "로드맵을 읽었을 때", cond, "'진행'·'할 일' 항목만",
  ]) assert.ok(row.includes(k), `프로젝트 행에 ${k} 없음`);
  for (const k of ["5 완료", "다음 배포까지", "0 인프라", "6 확장", "1 검토·2 계획"]) {
    assert.ok(!row.includes(k), `프로젝트 행에 옛 문구 ${k} 가 남음`);
  }
  const ph = lines(sec).filter((l) => l.startsWith("  - `phases`가 있으면 프로젝트 카드의"));
  assert.equal(ph.length, 1, "phases 하위 항목 줄이 정확히 1개가 아님");
  assert.ok(ph[0].includes(cond), "phases 줄에 단계 묶음 조건 문구 없음");
  assert.ok(!sec.includes("0·6단계"), "10장에 '0·6단계' 가 남음");
  assert.ok(sec.includes("인프라·확장 체크리스트"), "10장에 '인프라·확장 체크리스트' 없음");
});

test("docs H: ORCH_MANUAL 4장 ORCH_FABLE 행 1개·대체 순서, Architecture Variables 순서", () => {
  const rows = lines(read("docs/ORCH_MANUAL.md")).filter((l) => l.startsWith("| `ORCH_FABLE`"));
  assert.equal(rows.length, 1);
  const cells = rows[0].split("|").map((c) => c.trim());
  assert.equal(cells[3], "on");
  for (const w of ["Opus", "Sonnet", "대기"]) assert.ok(cells[4].includes(w), w);
  const arch = read("src/components/workspace/ArchitectureScreen.tsx");
  assert.ok(arch.includes("ORCH_OPUS · ORCH_FABLE"));
});

test("docs J: ORCH_MANUAL 7장 결과 화면 테스트 명령은 npm 스크립트", () => {
  const doc = read("docs/ORCH_MANUAL.md");
  const ls = lines(doc).filter((l) => l.startsWith("**결과 화면 테스트"));
  assert.equal(ls.length, 1);
  const l = ls[0];
  for (const w of [
    "`npm run build && npm run screens`",
    "`npm run build && npm run screens:ok`",
    "`npm run build && npm run screens:partial`",
    "switch-ok.png",
    "switch-partial.png",
    "가짜 GitHub 서버에만",
    "실제 저장소 설정은 바꾸지 않",
  ]) assert.ok(l.includes(w), w);
  assert.ok(!/SCREENS_SWITCH=\S*\s+npm/.test(doc), "옛 환경변수 앞붙임 명령이 남음");
  const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
  for (const k of ["screens", "screens:ok", "screens:partial"]) assert.ok(k in scripts, k);
});

test("docs K: ORCH_MANUAL 10장 AI 팀 행은 AGENT_ORDER·FLAG_KEYS 순서", () => {
  // 화면 코드의 AGENT_NAME·FLAG_TEXT 표시명과 같게 유지 (키가 늘면 typecheck 실패).
  const AGENT_LABEL: Record<AgentId, string> = { sonnet: "Sonnet", opus: "Opus", fable: "Fable", codex: "Codex", user: "사용자" };
  const FLAG_LABEL: Record<FlagKey, string> = {
    sonnet: "Sonnet", opus: "Opus", fable: "Fable", codex: "Codex",
    codexDev: "Codex 개발 대체", paused: "전체 일시정지", auto: "자동 모드",
  };
  const agents = AGENT_ORDER.map((k) => AGENT_LABEL[k]).join("·");
  const flags = FLAG_KEYS.map((k) => FLAG_LABEL[k]).join(" / ");

  const ch = section(read("docs/ORCH_MANUAL.md"), "## 10.", "## ");
  assert.ok(ch, "10장 없음");
  const rows = lines(ch).filter((l) => l.startsWith("| AI 팀 |"));
  assert.equal(rows.length, 1);
  const row = rows[0];

  // 정확 일치: 문서의 목록을 구분자로 잘라 소스 배열과 비교.
  const AI_HEAD = "**지금 일하는 AI**(";
  assert.ok(row.includes(AI_HEAD), AI_HEAD);
  const aStart = row.indexOf(AI_HEAD) + AI_HEAD.length;
  const aEnd = row.indexOf(":", aStart);
  assert.ok(aEnd > aStart, "AI 목록 뒤 ':' 없음");
  const docAgents = row.slice(aStart, aEnd);
  assert.equal(docAgents, agents);
  assert.deepEqual(docAgents.split("·"), AGENT_ORDER.map((k) => AGENT_LABEL[k]));

  const SW_HEAD = "**스위치**(";
  assert.equal(row.split(SW_HEAD).length - 1, 1, "'**스위치**(' 는 정확히 1번");
  const fStart = row.indexOf(SW_HEAD) + SW_HEAD.length;
  const fEnd = row.indexOf(")", fStart);
  assert.ok(fEnd > fStart, "스위치 목록 뒤 ')' 없음");
  const docFlags = row.slice(fStart, fEnd);
  assert.equal(docFlags, flags);
  assert.deepEqual(docFlags.split(" / "), FLAG_KEYS.map((k) => FLAG_LABEL[k]));

  // 위치 순서.
  const a = row.indexOf("**지금 일하는 AI**");
  const b = row.indexOf(agents);
  const c = row.indexOf("**사용량**");
  const d = row.indexOf(SW_HEAD);
  const e = row.indexOf("작업 시간대");
  for (const [n, v] of Object.entries({ a, b, c, d, e })) assert.ok(v >= 0, n);
  assert.ok(a < b && b < c && c < d && d < e, `순서 ${a} ${b} ${c} ${d} ${e}`);

  // 상태 문구 (AI 목록 구절 안).
  const agentPart = row.slice(a, c);
  for (const w of [
    "깊은 분석·가설·모델 설계(계획이 지정할 때)",
    "스위치를 한 곳 이상 읽었고 읽은 모든 프로젝트에서 그 AI가 꺼져 있으면 'OFF'",
    "스위치를 하나도 읽지 못하면 OFF 로 표시하지 않음",
    "사용자 행에는 OFF 가 없음",
    "OFF 가 아니면서 맡은 일이 없으면 '쉬는 중'",
    "OFF 인 행에는 '쉬는 중'과 맡은 일이 표시되지 않음",
  ]) assert.ok(agentPart.includes(w), w);
  for (const w of ["모두 맞추기", "n개 프로젝트에 적용", "일부 실패", "읽지 못함", "관리자 로그인"]) assert.ok(row.includes(w), w);
  for (const w of ["Sonnet / Opus / Codex / 전체 일시정지", "Sonnet·Opus·Codex·사용자"]) assert.ok(!row.includes(w), `옛 목록: ${w}`);
});

test("docs L: ORCH_MANUAL 4장·7장 Fable 대체 순서 일치", () => {
  const manual = read("docs/ORCH_MANUAL.md");
  const ch7 = section(manual, "## 7.", "## 8.");
  assert.ok(ch7, "7장을 찾지 못함");
  const fableLines = lines(ch7).filter((l) => l.startsWith('2. `"fable"`'));
  assert.equal(fableLines.length, 1, "7장 fable 2번 줄은 정확히 1개");
  const l7 = fableLines[0];
  for (const w of ["claude-fable-5-2", "ORCH_FABLE", "처음부터 Opus"]) assert.ok(l7.includes(w), w);
  const a = l7.indexOf("처음부터 Opus");
  const b = l7.indexOf("Opus도 꺼져 있으면 Sonnet");
  const c = l7.indexOf("셋 다 꺼져 있으면 대기");
  assert.ok(a >= 0 && b >= 0 && c >= 0 && a < b && b < c, `7장 순서 ${a} ${b} ${c}`);

  const rows = lines(manual).filter((l) => l.startsWith("| `ORCH_FABLE`"));
  assert.equal(rows.length, 1, "4장 ORCH_FABLE 행은 1개");
  const cell = rows[0].split("|").map((s) => s.trim())[4] ?? "";
  const o = cell.indexOf("Opus");
  const s = cell.indexOf("Sonnet");
  const w = cell.indexOf("대기");
  assert.ok(o >= 0 && s >= 0 && w >= 0 && o < s && s < w, `4장 순서 ${o} ${s} ${w}`);
});
