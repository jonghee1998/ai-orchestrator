"use client";
import { useDemo } from "@/components/workspace/DemoContext";
export function DemoBanner() {
  const { info } = useDemo();
  if (info.demo === false) return null;
  if (info.demo === "blocked") return <div role="alert" className="border-b border-danger/40 bg-danger/10 px-4 py-3 text-sm text-red-200" data-testid="demo-blocked">샘플 설정을 확인해 주세요. 안전을 위해 데이터 접근을 차단했습니다.<details><summary className="cursor-pointer py-2">설정 상세</summary>{info.reason}</details></div>;
  return <aside className="border-b border-warn/30 bg-warn/10 px-4 py-3 text-sm text-yellow-100" data-testid="demo-banner">
    <p className="font-medium">개발용 샘플 화면 · 실제 AI 실행 없음</p>
    <p className="mt-1 text-xs">오류도 샘플입니다. 시나리오 조작은 우측 상단 테스트 모드에서 합니다.</p>
  </aside>;
}
