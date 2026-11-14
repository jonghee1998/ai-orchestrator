# Phase 4 MVP — 대시보드 & 에이전트 제어 (Issue #19)

## 구성
- `src/lib/control/model.ts` — 순수 모델: 에이전트(`gpt`, `claude-sonnet`, `claude-opus`, `codex`), 프리셋, 스케줄, **`evaluateGate`**.
- `src/lib/control/service.ts` — 제어 변경(`mutateControl`), 비-dispatch provider 호출 게이트(`guardProviderCall`), 취소(`requestCancel`), 모니터링 스냅샷(`buildSnapshot`).
- `src/lib/runs/service.ts` — dispatch 경로 게이트: `requestDispatch`, `retryDispatchRecord`, **`authorizeSubmission`**(provider 호출 직전 필수).
- 설정/감사/차단 카운터는 run store와 **같은 직렬화 트랜잭션**(`StoreData.control/audit/blocked`)에 저장 → 게이트 판정이 레코드 생성과 원자적이며 재시작 후에도 유지.
- `GET /api/dashboard`(store만 읽음, provider 호출 없음), `POST /api/control`(`x-admin-token` = `CONTROL_ADMIN_TOKEN`, 미설정 시 503, 불일치 401), UI `/control`.

## 동작 규칙
- 기본값은 **전체 일시정지(fail-closed)**. 알 수 없는 agent 키는 항상 차단.
- Claude 전체 OFF는 Sonnet/Opus 둘 다 차단. 프리셋: GPT만 / Claude만 / 전체 켜기 / 전체 일시정지.
- 게이트는 신규 요청, 재시도, 제출 직전(`authorizeSubmission`)마다 평가. 차단 시 provider 호출 없음, **조용한 fallback 없음**.
- 큐에 있던 작업: 기본 **보류(held)**. `allowReroute` ON + 동일 capability + 활성 대상이 있을 때만 재라우팅.
- 실행 중 작업은 OFF 시 **drain**(건드리지 않음). 취소는 provider 지원 시에만 — 현재 지원 provider 없음 → 취소 확인을 주장하지 않음.
- 평일 스케줄(타임존 설정 가능)은 기본 비활성, 활성화 전에는 어떤 스케줄도 적용되지 않음.
- 사용량/비용: orchestrator가 발행한 dispatch 수만 표시. 제공사 사용량·비용은 텔레메트리 미연결 → `unknown`. 사용자의 별도 provider 사용량/계정 쿼터는 제어·측정하지 않음.

## 한계 / 우회 경로 (문서화)
- 이 게이트는 **orchestrator dispatch만** 강제한다. 외부 GitHub 트리거 에이전트(예: Issue 라벨로 기동되는 예약 루틴)가 차단되는지는 **검증되지 않았으며 우회될 수 있다**.
- Phase 3 실제 provider 연결, reconcile 스케줄링, 운영 DB, 라이브 자격증명은 후속. provider 호출 코드는 반드시 `authorizeSubmission`/`guardProviderCall`을 직전에 호출해야 함(아직 실제 호출 경로 없음).
- `FileRunStore`는 단일 프로세스 직렬화만 보장(다중 프로세스/인스턴스는 운영 DB 필요).
- 대시보드의 handoff는 held/rerouted 기록 기반이며 에이전트 간 실제 핸드오프 연동은 미연결.
