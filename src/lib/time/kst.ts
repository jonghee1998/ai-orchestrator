// 중앙 KST 표시 포매터 (#85). 저장/API 의미(UTC ISO)는 그대로 두고 화면 표기만 Asia/Seoul(UTC+9)로 변환한다.
// 한국은 DST 가 없으므로 고정 +9h 오프셋 산술을 쓴다 → 실행 환경의 TZ·로케일·ICU 와 무관하게 결정적이다.
const KST_OFFSET_MS = 9 * 3600_000;
const WEEKDAY_KO = ["일", "월", "화", "수", "목", "금", "토"];
const p2 = (n: number) => String(n).padStart(2, "0");

type Input = string | number | Date | null | undefined;

function toMs(v: Input): number | null {
  if (v === null || v === undefined || v === "") return null;
  const ms = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/** KST 로 옮긴 시각의 필드(요일 포함). */
function kstParts(ms: number) {
  const d = new Date(ms + KST_OFFSET_MS);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), wd: WEEKDAY_KO[d.getUTCDay()], h: p2(d.getUTCHours()), mi: p2(d.getUTCMinutes()), s: p2(d.getUTCSeconds()) };
}

/** "2026-11-16(월) 09:05:07 KST". 빈 값/잘못된 값은 fallback(기본 "없음"). 날짜 없는 ISO 문자열도 UTC 로 해석하지 않고 fallback 처리한다. */
export function formatKst(v: Input, fallback = "없음"): string {
  const ms = toMs(v);
  if (ms === null) return fallback;
  const k = kstParts(ms);
  return `${k.y}-${p2(k.mo)}-${p2(k.d)}(${k.wd}) ${k.h}:${k.mi}:${k.s} KST`;
}

/** 시각만 "HH:mm:ss KST" (전역 새로고침 표시용). */
export function formatKstTime(v: Input, fallback = "없음"): string {
  const ms = toMs(v);
  if (ms === null) return fallback;
  const k = kstParts(ms);
  return `${k.h}:${k.mi}:${k.s} KST`;
}

/** 짧은 형식 "M/D(요) HH:mm KST". */
export function formatKstShort(v: Input, fallback = "unknown"): string {
  const ms = toMs(v);
  if (ms === null) return fallback;
  const k = kstParts(ms);
  return `${k.mo}/${k.d}(${k.wd}) ${k.h}:${k.mi} KST`;
}

/** "YYYY-MM-DD(요)". 날짜만 있는 입력('YYYY-MM-DD')은 달력 날짜 그대로, ISO/epoch 는 KST 날짜로 변환한다. */
export function formatKstDate(v: Input, fallback = "없음"): string {
  if (typeof v === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
    if (m) {
      const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
      if (d.getUTCMonth() !== +m[2] - 1) return fallback;
      return `${m[1]}-${m[2]}-${m[3]}(${WEEKDAY_KO[d.getUTCDay()]})`;
    }
  }
  const ms = toMs(v);
  if (ms === null) return fallback;
  const k = kstParts(ms);
  return `${k.y}-${p2(k.mo)}-${p2(k.d)}(${k.wd})`;
}
