"use client";
// #85 — 데모 모드 표식. 서버 /api/demo 가 demo:false 이면 아무것도 렌더링하지 않는다(운영 화면 불변).
import { useEffect, useState } from "react";
import { refreshCenter } from "@/components/live/refresh";

type Info = { demo: false } | { demo: true; scenario: string; scenarios: string[] } | { demo: "blocked"; reason: string };
const LABEL: Record<string, string> = { normal: "정상(모든 상태)", empty: "빈 상태", "partial-failure": "부분 실패", error: "전체 오류" };

export function DemoBanner() {
  const [info, setInfo] = useState<Info>({ demo: false });
  useEffect(() => { fetch("/api/demo", { cache: "no-store" }).then(async (r) => setInfo((await r.json().catch(() => ({ demo: false }))) as Info)).catch(() => {}); }, []);
  if (info.demo === false) return null;
  if (info.demo === "blocked")
    return <div role="alert" className="bg-red-900/60 px-4 py-2 text-center text-xs font-semibold text-red-100" data-testid="demo-blocked">DEMO 차단됨: {info.reason} — 모든 API 가 fail-closed 입니다.</div>;
  const set = async (scenario: string) => {
    const r = await fetch("/api/demo", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scenario }) });
    setInfo((await r.json().catch(() => info)) as Info); void refreshCenter.refreshAll(); // 선택 즉시 전체 재조회(읽기 전용)
  };
  return (
    <div className="flex flex-wrap items-center justify-center gap-2 bg-yellow-900/60 px-4 py-1 text-xs text-yellow-100" data-testid="demo-banner">
      <b>DEMO</b><span>합성 데이터 · 실제 GitHub/DB/프로바이더 미사용</span>
      <label className="flex items-center gap-1">시나리오
        <select value={info.scenario} onChange={(e) => { void set(e.target.value); }} className="min-h-8 rounded border border-border bg-transparent px-1">
          {info.scenarios.map((s) => <option key={s} value={s} className="text-black">{LABEL[s] ?? s}</option>)}
        </select>
      </label>
      <button type="button" onClick={() => { void set("normal"); }} className="min-h-8 rounded border border-border px-2">초기화</button>
    </div>
  );
}
