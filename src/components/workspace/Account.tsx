"use client";
import { LoginCard } from "@/components/LoginCard";
import { useSession } from "@/components/live/session";
export function Account(){const s=useSession();return <details open={s.status!=="authed"} className="rounded-2xl border border-border bg-bg-card"><summary className="cursor-pointer px-4 py-3 text-sm">계정 · {s.status==="authed"?"로그인됨":"로그인 필요"}</summary><div className="p-2"><LoginCard/></div></details>}
