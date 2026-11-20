# AGENTS

> **2026-11-21 변경**: 작업 진행은 오케스트레이터 엔진이 담당합니다. 역할·운영 규칙의 기준 문서는
> [docs/ORCH_MANUAL.md](./docs/ORCH_MANUAL.md)이며, 아래 어댑터·라벨 규약(`agent:*`, `status:*`)은 이전 방식의 기록입니다.
>
> | 역할 | 담당 |
> |---|---|
> | PM | Claude |
> | 구현 | Claude Sonnet / Opus (스텝별 자동 선택) |
> | 독립 검수 | Codex 기본, 불가·OFF 시 Claude Opus 대체 |
> | 승인 | 사용자 |

AI Orchestrator가 관리하는 에이전트들의 역할, 연동 규약, 협업 원칙을 정의한다.

## 역할 분담

| 에이전트 | 역할 | 어댑터 역할값 | 연결 방식 (현재) | 연결 단계 |
|---|---|---|---|---|
| ChatGPT | PM · 작업 분배, 진행 관리, 최종 검수 | `pm` | 미정 | 후속 |
| Codex | 코드 개발 및 수정 | `developer` | CLI | 후속 |
| Claude Code | 코드 리뷰, 독립 검수, 개발 지원 | `reviewer` | 구독 기반 CLI 인증 (로컬) | **1차 연결 대상** |
| Pickle | 개인 데이터 수집, 외부 서비스 작업 | `collector` | 미정 | 후속 |

## 어댑터 계약

모든 에이전트는 `src/lib/agents/adapter.ts`의 `AgentAdapter` 인터페이스를 구현한다.

```ts
interface AgentAdapter {
  readonly descriptor: AgentDescriptor;
  checkConnection(): Promise<ConnectionStatus>;
  getUsage(): Promise<UsageQuota[]>;
  dispatch(task: Task): Promise<DispatchResult>;
}
```

### 필수 준수 사항

- **허위 연결 금지**: `checkConnection()`은 실제 검증에 성공한 경우에만 `connected`를 반환한다.
- **임의 수치 금지**: 사용량을 조회할 수 없으면 `Measured`의 `unknown`으로 반환한다.
- **클라우드 실행 구분**: 구독 기반 CLI 인증은 로컬 세션에 묶일 수 있으므로,
  `descriptor.cloudCapable`로 클라우드 자동 실행 가능 여부를 별도로 표기한다 (불명이면 `unknown`).

## 작업 전달 규약 (GitHub 중심)

작업의 단일 출처(source of truth)는 **GitHub Issues/PR**이다. 상세는
[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)를 참고한다.

| 개념 | GitHub 매핑 |
|---|---|
| 작업 | Issue 1개 |
| 담당 에이전트 | 라벨 `agent:<id>` |
| 작업 상태 | 라벨 `status:<state>` |
| 프로젝트 | 라벨 `project:<id>` 또는 마일스톤 |
| 협업/인계 | Issue 코멘트 (actor 표기) |
| 작업 결과 | 연결된 PR (`Closes #<issue>`) |

## 협업 흐름 (목표)

1. ChatGPT(PM)가 작업을 Issue로 생성하고 담당 에이전트를 라벨로 지정한다.
2. Codex가 코드를 작성해 PR로 회신한다.
3. Claude Code가 PR을 리뷰·독립 검수한다.
4. Pickle이 필요한 외부 데이터/작업을 수행해 Issue 코멘트로 회신한다.
5. ChatGPT가 최종 검수 후 머지 여부를 판단한다.

> Phase 1에서는 위 흐름의 **데이터 모델과 인터페이스만** 정의한다.
> 실제 자동 실행은 토큰 설정과 사용자 승인 후 Phase 2에서 구현한다.
