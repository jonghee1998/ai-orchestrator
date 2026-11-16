"use client";
import Link from "next/link";
import { Card } from "@/components/ui";
import type { Live } from "./useAuthedJson";

/** #83: 마지막 정상 데이터를 유지한 채 갱신(자동 폴링 포함)이 실패했음을 알린다. error 가 없으면 null. */
export function StaleNotice({ error }: { error: string | null | undefined }) {
  return error ? <p role="status" className="text-xs text-warn">최신 내용을 불러오지 못했습니다. 마지막으로 확인한 내용을 표시합니다.</p> : null;
}

/** Renders every non-ok state honestly. Returns null when data is ready. */
export function LiveStatus({ s, reload, what, error }: { s: Live<unknown>; reload: () => void; what: string; error?: string | null }) {
  if (s.kind === "ok") return <StaleNotice error={error} />;
  if (s.kind === "loading") return <p className="text-sm text-text-faint">불러오는 중…</p>;
  const msg = {
    notoken: <>로그인이 필요합니다. <Link href="/" className="text-accent">홈</Link>에서 한 번 로그인하면 {what}을(를) 조회한 자료를 표시합니다.</>,
    unauth: <>로그인이 만료되었거나 필요합니다. 다시 로그인하세요.</>,
    unconfigured: <>서버 설정이 없어 {what}을(를) 불러올 수 없습니다. 추정값은 표시하지 않습니다.</>,
    error: <>{what}을(를) 불러오지 못했습니다.</>,
  }[s.kind];
  return <Card><p className="text-sm">{msg}</p>{s.kind === "error" && <button className="mt-2 min-h-11 rounded-lg border border-border px-3 text-xs" onClick={reload}>다시 시도</button>}</Card>;
}
