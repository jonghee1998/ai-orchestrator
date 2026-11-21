"use client";
// 개발계 전용 공용 테스트 모드 버튼(우측 상단, 기본 닫힘). 기존 시뮬레이션/브리핑 시나리오 조작을 한곳에 모은다.
// 브라우저 저장 상태와 샘플 시나리오만 변경하며 외부 시스템은 변경하지 않는다.
import { useState } from "react";
import { useDemo } from "@/components/workspace/DemoContext";
import { useSimulation } from "@/components/workspace/SimulationContext";

const LABEL: Record<string, string> = { normal: "정상", empty: "빈 상태", "partial-failure": "부분 실패", error: "전체 오류" };
export function TestModeButton() {
  const [open, setOpen] = useState(false);
  const { info, select } = useDemo();
  const sim = useSimulation();
  if (info.demo !== true) return null; // dev-only
  const state = sim.state;
  return (
    <div className="relative" data-testid="test-mode">
      <button type="button" aria-expanded={open} aria-controls="test-mode-panel" onClick={() => setOpen((v) => !v)} className="inline-flex min-h-11 shrink-0 items-center rounded-lg border border-warn/50 px-3 text-xs text-yellow-100">테스트 모드</button>
      {open && (
        <div id="test-mode-panel" role="dialog" aria-label="테스트 모드" className="absolute right-0 top-12 z-40 max-h-[70dvh] w-[min(20rem,calc(100vw-2rem))] space-y-3 overflow-y-auto rounded-2xl border border-border bg-bg-card p-4 text-sm shadow-xl">
          <p className="text-xs text-yellow-100">개발용 샘플 화면 · 실제 AI·GitHub·DB를 호출하지 않습니다.</p>
          <label className="block text-xs text-text-muted">샘플 시나리오 (서버)
            <select aria-label="샘플 시나리오" value={info.scenario} onChange={(e) => { void select(e.target.value); }} className="mt-1 min-h-11 w-full rounded-lg border border-border bg-bg-card px-3 text-text">{info.scenarios.map((s) => <option key={s} value={s}>{LABEL[s] ?? s}</option>)}</select>
          </label>
          <button type="button" onClick={() => { void select("normal"); }} className="min-h-11 w-full rounded-lg border border-border px-3">샘플 시나리오 초기화</button>
          {state && <>
            <label className="block text-xs text-text-muted">개발계 시나리오
              <select aria-label="시나리오" value={state.scenario} onChange={(e) => sim.setScenario(e.target.value as typeof state.scenario)} className="mt-1 min-h-11 w-full rounded-xl border border-border bg-bg-raised px-3 text-text"><option value="normal">정상</option><option value="empty">빈 데이터</option><option value="partial-failure">부분 실패</option><option value="error">전체 오류</option></select>
            </label>
            <div className="grid grid-cols-2 gap-2">{state.usage.map((u) => <div key={u.id} className="rounded-xl border border-border p-2"><p className="text-xs font-medium">{u.name}</p>
              <button type="button" className="mt-2 min-h-11 w-full rounded-lg border border-warn/50 text-xs" onClick={() => sim.addUsage(u.id, 55)}>사용량 +55%</button>
              <button type="button" className="mt-2 min-h-11 w-full rounded-lg border border-border text-xs" onClick={() => sim.resetUsage(u.id)}>가상 초기화</button></div>)}</div>
            <button type="button" className="min-h-11 w-full rounded-xl border border-danger/50 text-red-200" onClick={sim.reset}>개발계 가상 데이터 초기화</button>
          </>}
          <p className="text-xs text-text-faint">브라우저 저장 상태만 변경합니다. 사용량 초기화 후에도 수동 OFF는 유지됩니다.</p>
        </div>
      )}
    </div>
  );
}
