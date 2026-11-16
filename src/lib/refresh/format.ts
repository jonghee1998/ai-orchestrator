import { formatKstTime } from "../time/kst";
/** 마지막 성공 시각 표기 (KST). 성공 이력이 없으면 가짜 시각 대신 "없음". */
export function formatRefreshTime(ms: number | null): string {
  return formatKstTime(ms, "없음");
}
