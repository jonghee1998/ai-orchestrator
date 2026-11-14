// 샘플 모드 안내 배너 — 실제 실행 데이터와 테스트용 UI 를 명확히 구분한다.
export function SampleBanner() {
  return (
    <div className="sticky top-0 z-10 border-b border-border bg-warn/10 px-4 py-2 text-center text-xs text-warn">
      샘플(데모) 모드 · 아직 실제 에이전트·작업 큐에 연결되지 않았습니다
    </div>
  );
}
