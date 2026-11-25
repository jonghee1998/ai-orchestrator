import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

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

test("docs E: NEW_PROJECT 8번 스위치 초기화에 ORCH_AUTO·ORCH_CODEX_DEV", () => {
  const l = lines(NEW_PROJECT()).filter((x) => x.startsWith("8. **스위치 초기화**"));
  assert.equal(l.length, 1);
  assert.ok(l[0].includes("ORCH_AUTO"));
  assert.ok(l[0].includes("ORCH_CODEX_DEV"));
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
