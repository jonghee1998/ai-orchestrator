import assert from "node:assert/strict";
import test from "node:test";
import { formatKst, formatKstShort, formatKstTime } from "./kst";

test("UTC → KST 변환과 명시적 KST 표기", () => {
  assert.equal(formatKst("2026-11-16T00:10:36Z"), "2026-11-16 09:10:36 KST");
  assert.equal(formatKstTime("2026-11-16T00:10:36.999Z"), "09:10:36 KST");
});
test("자정/날짜 롤오버 (UTC 15:00 = KST 다음날 00:00)", () => {
  assert.equal(formatKst("2026-11-16T14:59:59Z"), "2026-11-16 23:59:59 KST");
  assert.equal(formatKst("2026-11-16T15:00:00Z"), "2026-11-17 00:00:00 KST");
  assert.equal(formatKst("2026-12-31T15:00:00Z"), "2027-01-01 00:00:00 KST");
  assert.equal(formatKstShort("2026-02-28T16:30:00Z"), "3/1 01:30 KST");
});
test("오프셋이 붙은 ISO 와 epoch ms", () => {
  assert.equal(formatKst("2026-11-16T09:00:00+09:00"), "2026-11-16 09:00:00 KST");
  assert.equal(formatKst(Date.UTC(2026, 0, 1, 0, 0, 0)), "2026-01-01 09:00:00 KST");
});
test("빈 값/잘못된 값은 fallback", () => {
  assert.equal(formatKst(null), "없음");
  assert.equal(formatKst("not-a-date"), "없음");
  assert.equal(formatKstShort("x"), "unknown");
  assert.equal(formatKstTime(null, "-"), "-");
});
test("프로세스 TZ 와 무관 (다른 TZ 로 자식 프로세스 실행)", async () => {
  const { execFileSync } = await import("node:child_process");
  const code = `console.log(new Date(Date.UTC(2026,10,16,15,0,0)).getUTCHours())`;
  for (const tz of ["UTC", "America/Los_Angeles", "Asia/Tokyo"]) {
    assert.equal(execFileSync(process.execPath, ["-e", code], { env: { ...process.env, TZ: tz } }).toString().trim(), "15");
  }
  assert.equal(formatKst("2026-11-16T15:00:00Z"), "2026-11-17 00:00:00 KST");
});
