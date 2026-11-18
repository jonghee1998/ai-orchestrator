# AGENTS — AI Orchestrator 공통 운영 진입점

> **필수 읽기:** [시스템 명세](docs/SYSTEM_SPEC.md) · [이벤트/상태 규칙](docs/WORKFLOW_RULES.md) · [품질 게이트](docs/QUALITY_GATES.md) · [승인 정책](docs/APPROVAL_POLICY.md) · [검증 매트릭스](docs/TEST_MATRIX.md) · [다른 프로젝트 채택](docs/PROJECT_ADOPTION.md).
> 이 문서 집합은 명세이며 실제 Actions/CI/권한에서 강제됨을 의미하지 않는다. 기존 개별 Issue·사용자 승인과 충돌하면 안전하게 BLOCKED 하고 PM에 보고한다.

## 현재 작업 역할 (2026-11-18)
| 에이전트 | 현재 기본 역할 | 근거/검증 |
|---|---|---|
| GPT PM (ChatGPT Work) | 요구사항/완료조건, Issue 분배, 독립 근거 확인, 후속 판단, 사용자 협의 | GitHub Issue·PR·SHA·실제 실행 증거 |
| Claude Sonnet | **단독 개발**: 소스 검증, 사전 분석, 구현, 자체 검증, PR 작성 | 실제 START 세션과 커밋/테스트/PR 증거 |
| Codex | **독립 코드·영향 범위 검수** | 정확한 SHA의 실제 리뷰 결과 |
| GitHub Actions | CI, 이벤트 수신, 상태 갱신 및 필수 게이트(설정된 경우만) | workflow run 및 필수 체크 설정 |
| Pickle 등 기타 | 승인된 개별 데이터 수집/외부 작업 | 명시적 담당 및 실제 실행 증거 |

**주의:** 이전 버전의 "Codex 개발 / Claude 리뷰" 흐름은 현재 root #146 운영 역할과 다르다. 다른 프로젝트에 다른 역할을 적용할 경우 개발자/독립 검수자 분리와 승인 기록을 유지한다.

## 작업 시작 전 필수 절차
1. 사용자 승인 범위, root Issue, 인수조건, 소스 branch/full SHA 확인.
2. 실제 체크아웃 검증. 실패 시 파일 수정/임의 main 기반 작업 금지.
3. 사전 구조/영향/신뢰 경계·테스트 Oracle 분석 기록.
4. 단일 writer 개발 및 정상/부정/경계/동시 조합 테스트.
5. 새 PR 정확한 SHA에 대한 CI·Codex·보안 검수와 실 E2E 분리 확인.
6. 승인이 필요한 변경(main/배포/비용/보안/권한)은 사용자에게 보고 후 대기.

## GitHub의 역할
작업/증거의 운영 기록은 GitHub Issue·PR·댓글·Actions이다. 다만 사용자 승인과 독립 실행 증거가 없는 마커/댓글만으로 PASS 또는 권한을 창작하지 않는다. 정규화·수집·상태 계산의 불변 조건은 [WORKFLOW_RULES.md](docs/WORKFLOW_RULES.md).

## 기존 어댑터 인터페이스
`src/lib/agents/adapter.ts`의 `AgentAdapter`는 작업 연결 가능성과 보고에 활용한다. 연결 확인은 실제 검사 없이는 `connected`라고 하지 않는다. 사용량을 측정할 수 없으면 `unknown`으로 보고하며, 클라우드 실행 가능 여부와 실제 실행 여부를 구분한다.

## 다른 프로젝트
공통 규칙의 **자동 적용을 주장하지 말 것**. 대상 저장소가 [PROJECT_ADOPTION.md](docs/PROJECT_ADOPTION.md) 절차에 따라 채택하고 CI/Actions/필수 체크에 연결해야 강제할 수 있다.
