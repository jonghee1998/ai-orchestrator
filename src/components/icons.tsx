// 공용 SVG 아이콘 (획 굵기 1.8, round). 글자 기호(유니코드·이모지) 대신 쓴다.
// 장식용은 aria-hidden — 뜻은 옆의 글자나 부모의 aria-label 이 맡는다.

type IconProps = { className?: string };

function Svg({ className = "h-4 w-4", children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`inline-block shrink-0 ${className}`}
    >
      {children}
    </svg>
  );
}

export const RefreshIcon = (p: IconProps) => <Svg {...p}><path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" /></Svg>;
export const BackIcon = (p: IconProps) => <Svg {...p}><path d="M15 6l-6 6 6 6" /></Svg>;
export const AlertIcon = (p: IconProps) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5v.5" /></Svg>;
export const CheckIcon = (p: IconProps) => <Svg {...p}><path d="M5 12.5l4.5 4.5L19 7.5" /></Svg>;
export const PauseIcon = (p: IconProps) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M10 9v6M14 9v6" /></Svg>;
export const StopIcon = (p: IconProps) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M5.6 5.6l12.8 12.8" /></Svg>;
export const EditIcon = (p: IconProps) => <Svg {...p}><path d="M4 20l4-1 11-11-3-3L5 16z" /></Svg>;
export const KeyIcon = (p: IconProps) => <Svg {...p}><circle cx="8" cy="15" r="4" /><path d="M11 12l8-8M16 7l3 3" /></Svg>;

/** 체크박스 모양 상태: 통과(채운 원+체크) · 진행(파란 테두리+점) · 멈춤 · 대기(빈 원) · 해당 없음(줄) */
export type StateKind = "done" | "doing" | "blocked" | "todo" | "na";
export function StateIcon({ kind, className = "h-4 w-4" }: { kind: StateKind; className?: string }) {
  const base = `inline-block shrink-0 ${className}`;
  if (kind === "done")
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" className={`${base} text-ok`}>
        <circle cx="8" cy="8" r="8" fill="currentColor" />
        <path d="M4.6 8.3l2.4 2.4 4.4-4.8" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (kind === "doing")
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" className={`${base} text-accent`}>
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <circle cx="8" cy="8" r="2.6" fill="currentColor" />
      </svg>
    );
  if (kind === "blocked")
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" className={`${base} text-danger`}>
        <circle cx="8" cy="8" r="8" fill="currentColor" />
        <path d="M8 4.5v4M8 11v.6" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  if (kind === "na")
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" className={`${base} text-text-faint`}>
        <path d="M4 8h8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" className={`${base} text-text-faint`}>
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}
