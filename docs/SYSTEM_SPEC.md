# AI 개발 공통 운영 표준 — 시스템 명세 (v1)

> **적용 대상**: AI Orchestrator 및 이 표준을 채택한 다른 프로젝트. 문서 존재만으로 강제되지 않는다. 각 저장소에 적용·검증·필수 체크 설정이 필요하다.
> **우선순위**: 보안상 필수 검수와 명시적으로 금지된 작업은 기본 차단한다. 저장소 소유자의 최신 명시적 승인 > 프로젝트별 승인된 요구사항 > 이 공통 표준 > 개별 Issue의 일반 지시. 단, 일반적인 작업 승인은 독립 보안 검수 PASS를 대신하지 않는다. 보안 정책 완화에는 완화 대상과 위험을 특정한 별도 명시 승인이 필요하다. 승인·정책 증거가 서로 충돌하면 BLOCKED 후 PM이 확인한다.
> **규칙 원본**: 이 문서 집합은 *목표 명세*이며, 실제 코드·Actions·권한·E2E 근거와 반드시 대조해야 한다. 현 구현이 전체를 충족한다고 주장하지 않는다.

## 목표
사용자 요청 → GPT PM 요구사항/인수조건 및 작업 배정 → Claude Sonnet 단독 구현 → 자체 테스트 및 PR → Codex 독립 검수 → CI/품질/보안 게이트 → PASS/FAIL 처리 → 사용자 최종 승인 대기. 사람에게 불필요한 "계속?"을 요구하지 않지만, 승인이 필요한 작업은 멈춘다.

## 역할 및 권한
| 역할 | 책임 | 제한 |
|---|---|---|
| 사용자 (Owner) | 목표/요구 변경, 추가 한도·권한 결정, 최종 병합/배포 승인 | 명시 승인만 효력 |
| GPT PM (ChatGPT Work/자동화) | 요구/영향 분석, 이슈 분배, 증거 검증, FAIL 분석, 최종 판정, 사용자 소통 | 코드 작성자/검수자와 역할 분리, 자신의 댓글로 검수 PASS 날조 금지 |
| Claude Sonnet (Developer) | 정확한 HEAD 체크아웃, 사전 분석, 한 명만 코드 수정, 자체/반례 테스트, PR 생성 | ACK ≠ START ≠ 변경 ≠ 완료 |
| Codex (Independent reviewer) | 정확한 HEAD의 독립 코드·영향 범위 검수, 실제 리뷰 근거 기록 | 자기 승인으로 보안 리뷰를 대체하지 않음 |
| GitHub Actions | 이벤트 재계산, CI, 상태 발행, 승인 게이트 | 명세/워크플로가 실제 설치된 경우에만 작동 |

다른 프로젝트는 에이전트 구성을 바꿀 수 있지만 **개발자와 독립 검수자를 구분하고 실제 실행 증거를 요구**해야 한다.

## 작업 상태
`proposed → scoped → dispatched → acknowledged → started → developing → pr_open → ci_checking → review_checking → (rework | blocked | awaiting_user_approval)`.
미확인 상태는 `unknown/blocked`로 표시. `reported`는 ACK 또는 이슈 진행 보고로서 실제 START를 뜻하지 않는다.

## 진실성·추적성
- 모든 단계는 root ID, 작업 Issue, 실행 세션, PR, 정확한 전체 SHA, CI run, 독립 리뷰를 연결한다.
- 이전 PR/루트/승인/FAIL 이력을 바꾸거나 초기화하지 않는다. 새 요구사항은 별도 작업으로 추적한다.
- 자동화/시뮬레이션/단위 테스트/실제 GitHub E2E 결과를 엄격히 구분한다.
- 서로 모순되거나 불완전한 증거는 PASS가 아니라 BLOCKED/UNKNOWN.
- 별도 저장소에는 `docs/PROJECT_ADOPTION.md`의 적용 절차를 따른다.

## 다른 필수 문서
- [WORKFLOW_RULES.md](WORKFLOW_RULES.md) 이벤트와 상태 재계산
- [QUALITY_GATES.md](QUALITY_GATES.md) 단계별 PASS 조건
- [APPROVAL_POLICY.md](APPROVAL_POLICY.md) 승인·수정 한도
- [TEST_MATRIX.md](TEST_MATRIX.md) 검증 기준
- [PROJECT_ADOPTION.md](PROJECT_ADOPTION.md) 새 프로젝트 적용
