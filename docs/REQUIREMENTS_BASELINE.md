# AI Orchestrator — 통합 요구사항 기준서 v1.0 (감사 초안)

> 상태: **검토용 / 미승인 기준선** · 작성: 2026-11-20 · 범위: 전체 코드 감사의 요구사항 대조 기준  
> 변경 절차: 새 요구 또는 우선순위 변경은 근거 Issue/댓글, 영향 범위, 승인 상태를 기록하고 버전 갱신. 기존 승인·실패·수정 이력은 소급 삭제하지 않는다.  
> 주의: 이 문서를 GitHub에 게시했다고 기능 구현·자동 강제·운영 검증이 완료된 것은 아니다.

## 1. 목표 / 성공 정의

사용자가 목표를 제시하면 GPT PM이 기술적 타당성·기존 시스템·대안·위험·비용을 독립적으로 검토해 작업과 인수조건을 명세하고, 승인된 Claude/Codex 실행 경로로 개발·테스트·PR·독립 검수·FAIL 수정·통합 E2E·사용자 승인 대기를 이어가는 클라우드 오케스트레이터. 사용자는 모바일에서 프로젝트/담당 AI/다음 행동/차단 원인·증거를 확인하고 각 실행 에이전트를 ON/OFF하며, 최종 병합·배포 등 중요한 결정만 내린다.

완료는 UI 또는 댓글의 PASS가 아니라 **실제 이벤트 → 인증된 에이전트 START → 코드·PR → 실제 CI·독립 리뷰·보안 → 재작업 → E2E → 승인 대기**가 새 테스트 프로젝트에서 검증되었을 때로 제한한다.

## 2. 필수 기능 / 감사 ID

| ID | 요구사항 | 필수 인수조건 |
|---|---|---|
| R01 GPT PM | 요구사항 검증, 기존 코드 재사용, 아키텍처·보안·비용·대안 비교, 독립 검증 | 동의만 하지 않고 근거·권고·미확인을 구분; 사용자 최종 승인권 보존 |
| R02 프로젝트 | 목표·범위·인수조건·의존성·우선순위·담당·진행·이력 관리 | 실제 GitHub 데이터와 연결; 완료율은 증거 기반; 여러 프로젝트 상태 격리 |
| R03 에이전트 | Sonnet·Opus·Codex 별도 가용성/ON-OFF/사용량/실행 증거; GPT PM은 항상 활성 | OFF는 **서버 측 신규 dispatch·재시도·외부 트리거 경로** 차단, 기존 실행 기본 drain, 상태 영속성·경쟁·우회 검증. 통제 불가능한 외부 경로는 BLOCKED 명시 |
| R04 개발 | 인증된 저장소·branch·full SHA 검사 → 사전 영향/신뢰 경계 분석 → 단일 writer → 테스트/PR | ACK와 실제 START 구분; 부정/경계/동시 테스트 및 정확한 실행 세션 근거 |
| R05 검수 | CI, 정확한 SHA Codex 등 작성자와 분리된 코드 리뷰, 독립 보안, 재작업 | PASS/FAIL 충돌·누락·공유 SHA·오래된 상태에 fail-closed, 최대 기본 3회 후 협의, root #146 예외 이력 보존 |
| R06 모바일 | 프로젝트/AI 팀/PM 브리핑 3탭, 사용량 근거/갱신, 담당·차단·다음 행동, 승인 | 모바일 360/390/430; 인증 전 데이터 노출 금지; dev-only 시뮬레이션 격리 |
| R07 공통 규칙 | G0~G8 품질 절차, 신규 프로젝트 채택/버전 고정, 실제 CI·Actions·branch ruleset 연결 | configured/enforced/live-verified 각각 구분; 문서 존재만으로 완료 금지 |
| R08 ECC | 기존 코드와 비교 후 검증된 Skills/Rules/Hooks 등 선별 도입 | 충돌·권한·비용·토큰·보안·실효성 검증; 미완성 ECC는 즉시 전체 강제하지 않음 |
| R09 운영 | PC 종료와 무관한 지원 클라우드 경로, 최소 권한·안전한 중단·복구·감사 | 무단 main/운영 배포/유료 API/보안 완화 금지; 중복 이벤트·재시작·타임아웃/인증 오류 회귀 테스트 |

## 3. 운영 절차 및 품질 증거

- G0 PM 목표·범위·인수조건 → G1 원본/권한/정확한 HEAD → G2 **첫 코드 커밋 전** 구조·테스트 분석 → G3 자체 검증 → G4 CI/이벤트 → G5 독립 코드·영향 검수 → G6 독립 보안 → G7 실제 E2E → G8 사용자 승인.
- GitHub Issue/PR/댓글/Actions는 운영 이력의 증거이되, 라벨/자체 댓글만으로 provider 실행·검수 PASS로 인정하지 않는다.
- GitHub 이벤트는 힌트일 뿐: authenticated live fetch → 정규화된 증거 스냅샷 → 영향 PR 집합(이전/현재 root 및 공유 SHA 포함) → 필수 컨텍스트 무효화 → 공통 판정 → 정확한 HEAD 발행 → 후속 행동.
- 기본 root는 실패 후 코드 수정 3회, 초과 시 해당 root만 BLOCKED하고 협의. #146은 과거 n1~n16 및 승인 예외를 보존하며 임의 reset/무제한 cap 금지.
- 승인 없는 main 병합, prod 배포, 새 유료 API, 인증/보안/권한 완화 금지.

## 4. 기존 요구 간 충돌 — 확정 전 감사 대상으로 유지

| 주제 | 과거/현재 기록 | 잠정 판단·검증 작업 |
|---|---|---|
| Codex 개발 | #146은 Claude/Codex 모두 독립 개발·리뷰 가능 요구. 공통 명세는 Sonnet 개발·Codex 독립 리뷰를 기본 역할로 규정 | **기본 역할과 기술적 역량을 분리.** 현재 Codex 개발 checkout/auth 장애는 미해결. 개발 경로를 폐기하지 않고 별도 복구 조건 및 실제 스모크로 검증 |
| 모바일 네비게이션 | #90 4탭→#92 3탭 승인, #198 ECC 문구에 4탭 | 최신 명시적 #92 3탭을 기본 후보로 두되, #198의 4탭 문구는 미정합으로 표시. 임의 UI 변경 금지 |
| GPT toggle | #15 GPT OFF 포함, #95는 GPT 항상 활성 | #95 우선, GPT PM 토글 제거; 실제 구현·지속 상태 검증 |
| 외부 에이전트 OFF | UI/DB off와 Claude Routine·GitHub 외부 트리거는 별개 | 모든 실제 호출 경로 조사; 제어 불가 경로가 있으면 전체 통제 PASS 금지 |
| 공통 매뉴얼의 강제력 | #196 문서/PR, #197 채택 게이트 미완료 | docs-only와 실제 required checks/default-branch 동작을 분리 |
| ECC 범위 | #198에 장기 A1–C6 요구가 존재, #199는 검증 slice 1 | 전체 ECC 대체·일괄 설치 금지; 기능 별로 중복·효과·보안·비용 확인 |

## 5. 전수 코드 감사 계획과 결과 형식

**감사 범위**: (a) main/통합/진행 PR의 실제 HEAD·계보·누락, (b) 인증·권한·서버 측 agent gate·dispatch와 외부 webhook/routine, (c) GitHub Issues/PR·이벤트·상태·reconciler, (d) review receipts·CI·security·품질 게이트, (e) DB/API/로그인, (f) 모바일 실제/데모 데이터, (g) 문서·프로젝트 채택, (h) ECC 중복/도입 지도.

각 항목 기록: 요구 ID → 경로/함수/설정 → 존재 여부 → 정상·부정·경계 테스트 → 정확한 브랜치/SHA/실행 증거 → 판정 **유지 / 개선 / 재설계 / 신규 / 보류** → 원인·영향·우선순위. 단위 CI 성공과 실제 E2E 성공을 분리하며, 감사만으로 배포/코드 수정하지 않는다.

**1차 리뷰 권장 순서**: 인증·ON/OFF·provider 실제 호출 → 이벤트/dispatch/복구 → 품질 게이트/독립 리뷰 → 모바일·프로젝트 사실성 → ECC 설계 적합성.

## 6. 근거 및 규칙 링크

- 초기 agent ON/OFF: [#15](https://github.com/jonghee1998/ai-orchestrator/issues/15), [#21](https://github.com/jonghee1998/ai-orchestrator/issues/21)
- 모바일 v2·로그인: [#92](https://github.com/jonghee1998/ai-orchestrator/issues/92), [#95](https://github.com/jonghee1998/ai-orchestrator/issues/95)
- 실제 자동 실행/양자 developer gate: [#146](https://github.com/jonghee1998/ai-orchestrator/issues/146)
- 공통 매뉴얼: [PR #196](https://github.com/jonghee1998/ai-orchestrator/pull/196), [#197](https://github.com/jonghee1998/ai-orchestrator/issues/197)
- ECC: [#198](https://github.com/jonghee1998/ai-orchestrator/issues/198), [PR #199](https://github.com/jonghee1998/ai-orchestrator/pull/199)

이 명세는 **감사 기준 초안**이며 코드 구현·병합·운영 활성화를 승인하거나 변경하지 않는다.
