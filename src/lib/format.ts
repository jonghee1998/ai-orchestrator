// 표시용 포매팅 유틸

import type { Measured } from "./types";

/** Measured 값을 화면 문자열로 변환. unknown 이면 "unknown" 을 반환한다. */
export function showMeasured<T>(
  m: Measured<T>,
  render: (v: T) => string = (v) => String(v),
): string {
  return m.state === "known" ? render(m.value) : "unknown";
}

/** ISO 시각을 짧은 한국어 형식으로 */
export function showMeasuredDate(m: Measured<string>): string {
  return showMeasured(m, (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "unknown";
    return d.toLocaleString("ko-KR", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  });
}

export function showDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  return d.toLocaleString("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
