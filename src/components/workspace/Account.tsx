"use client";
import { ChevronIcon } from "@/components/icons";
import { LoginCard } from "@/components/LoginCard";
import { useSession } from "@/components/live/session";
// 카드 모양(흰 바탕·18px·옅은 그림자)의 접기. 안의 LoginCard 는 카드 없이(plain) 그려 카드 안 카드를 피한다.
export function Account(){const s=useSession();return <details open={s.status!=="authed"} className="rounded-[18px] bg-bg-card shadow-[0_1px_2px_rgba(17,20,24,.04),0_4px_16px_rgba(17,20,24,.04)]"><summary className="flex cursor-pointer items-center px-4 text-sm text-text-muted"><span className="flex-1">계정 · {s.status==="authed"?"로그인됨":"로그인 필요"}</span><ChevronIcon className="h-4 w-4"/></summary><div className="border-t border-border px-4 py-3"><LoginCard plain/></div></details>}
