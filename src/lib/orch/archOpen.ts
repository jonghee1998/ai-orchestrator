// 구조 탭 카드 펼침 상태. localStorage 키 하나에 펼친 카드 id(자기 카드 "self", 나머지는 저장소 이름) 배열을 JSON 으로 저장한다.
// 저장소 접근이 막히거나 값이 깨져 있으면 모두 접힘.

export const ARCH_OPEN_KEY = "orch.arch.open";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function readArchOpen(storage: () => StorageLike | null | undefined): string[] {
  try {
    const raw = storage()?.getItem(ARCH_OPEN_KEY);
    if (!raw) return [];
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && x !== ""))] : [];
  } catch {
    return [];
  }
}

export function writeArchOpen(storage: () => StorageLike | null | undefined, ids: string[]): boolean {
  try {
    const s = storage();
    if (!s) return false;
    s.setItem(ARCH_OPEN_KEY, JSON.stringify([...new Set(ids)]));
    return true;
  } catch {
    return false;
  }
}

export function toggleArchOpen(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((r) => r !== id) : [...list, id];
}

// ---- 다이어그램 상자 글자 계산 (11px 글자, 줄 높이 14)
export const ARCH_FONT = 11;
export const ARCH_LINE_H = 14;

/** 상자에 들어가는 줄 수: 위아래 여백 3씩 빼고 줄 높이로 나눈다 (높이 20 미만이면 0). */
export function boxLineCount(h: number, lines: number): number {
  return Math.max(0, Math.min(lines, Math.floor((h - 6) / ARCH_LINE_H)));
}

/** 상자 너비(w-12)에 맞춘 한 줄 글자 수 상한 (한글 한 글자 ≈ 11px 로 보수적으로). */
export function boxMaxChars(w: number): number {
  return Math.max(0, Math.floor((w - 12) / ARCH_FONT));
}

/** 줄을 maxChars 안으로 줄이고 넘으면 말줄임표를 붙인다. 한 글자도 못 들어가면 "". */
export function fitLine(line: string, maxChars: number): string {
  const chars = [...line];
  if (maxChars < 1) return "";
  if (chars.length <= maxChars) return line;
  return chars.slice(0, maxChars - 1).join("") + "…";
}
