"use client";
import Link from "next/link";
import { Card } from "@/components/ui";
import type { Live } from "./useAuthedJson";

/** Renders every non-ok state honestly. Returns null when data is ready. */
export function LiveStatus({ s, reload, what }: { s: Live<unknown>; reload: () => void; what: string }) {
  if (s.kind === "ok") return null;
  if (s.kind === "loading") return <p className="text-sm text-text-faint">불러오는 중…</p>;
  const msg = {
    notoken: <>토큰이 없습니다. <Link href="/" className="text-accent">홈</Link>에서 토큰을 입력하면 {what}을(를) 실제 데이터로 표시합니다.</>,
    unauth: <>토큰이 올바르지 않습니다 (401).</>,
    unconfigured: <>서버 설정이 없어 {what}을(를) 불러올 수 없습니다 (unconfigured). 추정값은 표시하지 않습니다.</>,
    error: <>{what}을(를) 불러오지 못했습니다{s.kind === "error" ? ` (${s.detail})` : ""}.</>,
  }[s.kind];
  return <Card><p className="text-sm">{msg}</p>{s.kind === "error" && <button className="mt-2 min-h-11 rounded-lg border border-border px-3 text-xs" onClick={reload}>다시 시도</button>}</Card>;
}
