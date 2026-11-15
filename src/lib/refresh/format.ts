/** 마지막 성공 시각 표기. 성공 이력이 없으면 가짜 시각 대신 "없음". */
export function formatRefreshTime(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "없음";
  return new Date(ms).toISOString().replace("T", " ").slice(11, 19) + "Z";
}
