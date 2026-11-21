# AI Orchestrator

ChatGPT · Codex · Claude Code · Pickle을 하나의 **모바일 웹 대시보드**에서 관리하고,
**GitHub를 중심으로** 작업을 배정·협업하는 개인 AI 오케스트레이션 시스템.

> 현재 상태 (2026-11-21): **엔진 이전 완료 · 상황판 운영 배포 연결** — 작업 진행은 GitHub Actions 오케스트레이터(`scripts/orch/`)가 담당하고,
> 이 앱은 진행 상황판으로 바뀝니다. 운영 방법은 **[운영 매뉴얼](docs/ORCH_MANUAL.md)**, 진행 추적은 #206.

## 에이전트 역할

| 에이전트 | 역할 |
|---|---|
| Claude (PM) | 요구사항 정리·계획 Issue 작성, 1시간마다 점검, 판단 필요 시 알림 |
| Claude Sonnet / Opus | 스텝 단위 구현 (난이도·위험도에 따라 자동 선택, 반복 실패 시 Opus로 상향) |
| Codex | 독립 검수 (기본). 쓸 수 없거나 OFF면 Claude Opus가 별도 세션에서 대체 검수 |
| GitHub Actions | CI, 상태 전이, 스텝 PR 자동 머지, 위험도 판정 |
| 사용자 | 시작 승인(`orch:go`), 위험한 변경의 최종 머지, 배포 |

각 AI는 저장소 변수 `ORCH_SONNET` / `ORCH_OPUS` / `ORCH_CODEX` / `ORCH_PAUSED` / `ORCH_WINDOW`로 끄고 켭니다 (매뉴얼 4장).

이전 방식(GPT PM, handoff coordinator)의 작업 기록은 `archived:pre-engine` 라벨과 `archive/pre-engine-2026-11-21` 브랜치에 보존되어 있습니다.

## 기술 스택

- Next.js 15 (App Router) + TypeScript
- Tailwind CSS (모바일 우선 다크모드)

## 로컬 실행

```bash
npm install
npm run dev        # http://localhost:3000
npm run typecheck  # 타입 검사
npm run build      # 프로덕션 빌드
```

환경 변수는 `.env.example`를 참고해 `.env.local`에 작성합니다.
토큰·API 키·인증정보는 **절대 저장소에 커밋하지 않습니다** (`.gitignore` 처리됨).

관리자 아이디·비밀번호 최초 설정은 [docs/ADMIN_LOGIN.md](docs/ADMIN_LOGIN.md)를 참고합니다. 기본 계정은 없습니다.

## 화면 구성

- **홈** — 전체 상태 요약 (연결 에이전트, 진행 프로젝트, 열린 작업)
- **프로젝트** — 프로젝트별 작업 목록·담당 에이전트·진행 상황
- **에이전트** — 연결 상태, 사용 한도, 초기화 시각, 클라우드 실행 가능 여부
- **작업** — GitHub Issue 기반 작업 큐
- **활동** — 실행 로그 및 에이전트 간 협업 기록

## 설계 원칙 (중요 제약)

- 실제 연결되지 않은 에이전트를 **연결 완료로 표시하지 않습니다**. 기본값은 `연결 안 됨`.
- 사용량·진행률을 **임의로 생성하지 않습니다**. 확인할 수 없으면 `unknown`으로 표시.
- 샘플(데모) 데이터는 UI 상단 배너와 `SAMPLE_MODE` 플래그로 **실제 데이터와 명확히 구분**.
- 구독 기반 CLI 인증과 클라우드 자동 실행 가능 여부를 **구분**합니다.
- 유료 API 사용, 외부 서비스 가입, 운영 배포는 **사용자 승인 후** 진행합니다.
- 기존 `private_dashboard` 저장소는 수정하지 않습니다.

## 문서

- [AGENTS.md](./AGENTS.md) — 에이전트 역할·연동 규약·협업 원칙
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — 시스템 구조와 설계 결정
- [docs/ROADMAP.md](./docs/ROADMAP.md) — 단계별 로드맵
- [docs/ISSUE36.md](./docs/ISSUE36.md) — PM 브랜치/SHA 고정, 구독 CLI 협업 인계와 실행 검증
