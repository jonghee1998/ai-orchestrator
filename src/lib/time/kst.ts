// 중앙 KST 표시 포매터 (#85). 저장/API 의미(UTC ISO)는 그대로 두고 화면 표기만 Asia/Seoul(UTC+9)로 변환한다.
// 한국은 DST 가 없으므로 고정 +9h 오프셋 산술을 쓴다 → 실행 환경의 TZ·로케일·ICU 와 무관하게 결정적이다.
const KST_OFFSET_MS = 9 * 3600_000;
const p2 = (n: number) => String(n).padStart(2, "0");

function toMs(v: string | number | Date | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const ms = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/** "2026-11-16 09:05:07 KST". 빈 값/잘못된 값은 fallback(기본 "없음"). 날짜 없는 ISO 문자열도 UTC 로 해석하지 않고 fallback 처리한다. */
export function formatKst(v: string | number | Date | null | undefined, fallback = "없음"): string {
  const ms = toMs(v);
  if (ms === null) return fallback;
  const d = new Date(ms + KST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} KST`;
}

/** 시각만 "HH:mm:ss KST" (전역 새로고침 표시용). */
export function formatKstTime(v: string | number | Date | null | undefined, fallback = "없음"): string {
  const s = formatKst(v, "");
  return s ? s.slice(11) : fallback;
}

/** 짧은 형식 "M/D HH:mm KST". */
export function formatKstShort(v: string | number | Date | null | undefined, fallback = "unknown"): string {
  const ms = toMs(v);
  if (ms === null) return fallback;
  const d = new Date(ms + KST_OFFSET_MS);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} KST`;
}
