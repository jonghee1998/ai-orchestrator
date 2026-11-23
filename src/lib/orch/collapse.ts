// 프로젝트 카드 접힘 상태 (홈). localStorage 키 하나에 접힌 저장소 이름 배열을 JSON 으로 저장한다.
// 저장소 접근이 막히거나(사파리 개인 정보 보호 모드 등) 값이 깨져 있으면 기본값(모두 펼침)을 쓴다.

export const COLLAPSED_KEY = "orch.projects.collapsed";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

/** Collapsed repo names; any failure or odd value → [] (all expanded). Non-string entries are dropped. */
export function readCollapsed(storage: () => StorageLike | null | undefined): string[] {
  try {
    const raw = storage()?.getItem(COLLAPSED_KEY);
    if (!raw) return [];
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && x !== ""))] : [];
  } catch {
    return [];
  }
}

/** Save collapsed repo names; returns false if storage is unavailable (state then lives only in memory). */
export function writeCollapsed(storage: () => StorageLike | null | undefined, repos: string[]): boolean {
  try {
    const s = storage();
    if (!s) return false;
    s.setItem(COLLAPSED_KEY, JSON.stringify([...new Set(repos)]));
    return true;
  } catch {
    return false;
  }
}

/** Toggle one repo in the collapsed list (new array). */
export function toggleCollapsed(list: string[], repo: string): string[] {
  return list.includes(repo) ? list.filter((r) => r !== repo) : [...list, repo];
}
