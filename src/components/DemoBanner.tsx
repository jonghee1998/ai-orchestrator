"use client";
import { useDemo } from "@/components/workspace/DemoContext";
const LABEL: Record<string, string> = { normal: "정상", empty: "빈 상태", "partial-failure": "부분 실패", error: "전체 오류" };
export function DemoBanner() {
  const { info, select } = useDemo();
  if (info.demo === false) return null;
  if (info.demo === "blocked") return <div role="alert" className="border-b border-danger/40 bg-danger/10 px-4 py-3 text-sm text-red-200" data-testid="demo-blocked">샘플 설정을 확인해 주세요. 안전을 위해 데이터 접근을 차단했습니다.<details><summary className="cursor-pointer py-2">설정 상세</summary>{info.reason}</details></div>;
  return <aside className="border-b border-warn/30 bg-warn/10 px-4 py-3 text-sm text-yellow-100" data-testid="demo-banner">
    <p className="font-medium">개발용 샘플 화면 · 실제 AI 실행 없음</p>
    <details><summary className="min-h-11 cursor-pointer py-3 text-xs">샘플 시나리오 · {LABEL[info.scenario]}</summary>
      <div className="flex flex-wrap items-center gap-2"><label>시나리오 <select aria-label="샘플 시나리오" value={info.scenario} onChange={e => { void select(e.target.value); }} className="min-h-11 rounded-lg border border-border bg-bg-card px-3 text-text">{info.scenarios.map(s => <option key={s} value={s}>{LABEL[s]}</option>)}</select></label><button onClick={() => { void select("normal"); }} className="min-h-11 rounded-lg border border-border px-3">초기화</button></div>
      <p className="mt-2 text-xs">오류도 샘플입니다. 실제 서비스 연결은 의도적으로 사용하지 않습니다.</p>
    </details>
  </aside>;
}
