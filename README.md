# AI Orchestrator

ChatGPT · Codex · Claude Code · Pickle을 하나의 **모바일 웹 대시보드**에서 관리하고,
**GitHub를 중심으로** 작업을 배정·협업하는 개인 AI 오케스트레이션 시스템.

> 현재 상태: **Phase 1 (기반 구조)** — 대시보드 UI, 어댑터 인터페이스, GitHub 작업 큐 설계.
> 에이전트와 작업 큐는 아직 **실제로 연결되지 않았습니다** (샘플 모드).

## 에이전트 역할

| 에이전트 | 역할 |
|---|---|
| ChatGPT | PM · 작업 분배, 진행 관리, 최종 검수 |
| Codex | 코드 개발 및 수정 |
| Claude Code | 코드 리뷰, 독립 검수 및 개발 지원 (1차 연결 대상) |
| Pickle | 개인 데이터 수집 및 외부 서비스 작업 |

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
