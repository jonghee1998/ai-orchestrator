// 샘플 데이터 구역 표시 — 전역 배너가 아니라, 샘플(data.ts)을 실제로 렌더링하는 구역에만 붙인다.
// (실제 연결된 화면을 "샘플 모드"라고 잘못 표기하지 않기 위함 — Issue #31)
export function SampleBanner({ what = "이 목록" }: { what?: string }) {
  return (
    <div role="note" className="mb-3 rounded-lg border border-border bg-warn/10 px-3 py-2 text-xs text-warn">
      샘플(데모) 데이터 · {what}은(는) 실제 에이전트·작업 큐에 연결되지 않은 고정 예시입니다. 실제 상태는 홈(/)·제어(/control)·작업(/tasks)에서 확인하세요.
    </div>
  );
}
