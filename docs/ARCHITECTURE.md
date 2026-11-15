# 아키텍처

## 개요

AI Orchestrator는 여러 AI 에이전트를 **GitHub를 작업 중심축**으로 삼아 조율하는
개인용 대시보드다. 최종 목표는 **PC를 종료해도 운영 가능한 클라우드 실행 구조**이지만,
Phase 1은 로컬에서 동작하는 기반 구조를 만드는 데 집중한다.

```
┌─────────────────────────────────────────────┐
│          모바일 웹 대시보드 (Next.js)          │
│   홈 · 프로젝트 · 에이전트 · 작업 · 활동        │
└───────────────┬─────────────────────────────┘
                │ 읽기/표시 (현재: 샘플 데이터)
                ▼
┌─────────────────────────────────────────────┐
│       도메인 모델 (src/lib/types.ts)          │
│   Agent · Project · Task · Activity           │
│   Measured<T> = known | unknown               │
└───────┬─────────────────────┬───────────────┘
        │                     │
        ▼                     ▼
┌───────────────┐     ┌───────────────────────┐
│ 어댑터 레이어   │     │  GitHub 작업 큐         │
│ AgentAdapter  │     │  TaskQueue (Issues/PR) │
│ · claude-code │     │  라벨 규약 기반          │
│ · codex       │     └───────────┬───────────┘
│ · chatgpt     │                 │
│ · pickle      │                 ▼
└───────┬───────┘          ┌─────────────┐
        │                  │   GitHub    │
        └─────────────────▶│ Issues / PR │
          실제 실행(Phase2) └─────────────┘
```

## 레이어

### 1. 도메인 모델 — `src/lib/types.ts`
전역 공유 타입. 핵심은 `Measured<T>`로, **확인할 수 없는 값을 1급으로** 표현한다.
사용량·진행률·초기화 시각 등은 `known | unknown`으로 다뤄 임의 수치 생성을 구조적으로 차단한다.

### 2. 어댑터 레이어 — `src/lib/agents/`
- `adapter.ts` — `AgentAdapter` 인터페이스와 공통 타입
- `claude-code.ts` — **1차 연결 대상**. 구독 CLI 인증 검증은 Phase 2.
- `placeholder.ts` — ChatGPT/Codex/Pickle 공통 placeholder (연결 전)
- `registry.ts` — 어댑터 등록/조회

대시보드와 작업 큐는 구체 어댑터가 아닌 `AgentAdapter` 인터페이스에만 의존한다.

### 3. GitHub 작업 큐 — `src/lib/github/task-queue.ts`
작업의 단일 출처는 GitHub Issues/PR. `TaskQueue` 인터페이스와 라벨 규약을 정의한다.
실제 Octokit 구현은 Phase 2 (토큰 설정 + 사용자 승인 후).

| 개념 | GitHub 매핑 |
|---|---|
| 작업 | Issue |
| 담당 | 라벨 `agent:<id>` |
| 상태 | 라벨 `status:<state>` |
| 프로젝트 | 라벨 `project:<id>` / 마일스톤 |
| 협업/인계 | Issue 코멘트 |
| 결과 | PR (`Closes #<issue>`) |

### 4. UI — `src/app/`, `src/components/`
Next.js App Router. 모바일 우선 다크모드. 하단 탭 네비게이션.
`SampleBanner`와 `SAMPLE_MODE` 플래그로 실제 데이터와 샘플을 구분한다.

## 설계 결정

- **"모르면 unknown"의 타입화**: 신뢰성을 위해 `Measured<T>`로 불확실성을 명시.
- **허위 연결 차단**: 어댑터 기본 구현은 `disconnected` / `unknown`을 반환.
- **실행과 표시의 분리**: Phase 1은 표시(UI)·설계(인터페이스)만. 실제 실행은 Phase 2.
- **구독 인증 ≠ 클라우드 실행**: `cloudCapable`로 분리해 클라우드 운영 가능 여부를 별도 추적.

## 보안

- 토큰/API 키/인증정보는 코드에 포함하지 않으며 `.gitignore`로 제외.
- 구독 기반 CLI 인증은 로컬 머신의 자격 증명을 사용하고 저장소에 저장하지 않는다.
- 외부 서비스 연동·유료 API·운영 배포는 사용자 승인 후 진행.

## 클라우드 실행 (최종 목표, 미확정)

PC 종료 후에도 운영하려면 각 에이전트의 인증을 클라우드에서 재현할 수 있어야 한다.
구독 기반 CLI 인증은 이것이 **보장되지 않으므로**, 각 에이전트별 `cloudCapable`을
실측해 가능한 것부터 단계적으로 클라우드로 이전한다. 구체 방식은 Phase 3에서 검토한다.
