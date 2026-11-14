# 로드맵

단계별로 나누어 진행하며, 각 단계는 **사용자 검수 후** 다음으로 넘어간다.
유료 API·외부 서비스 가입·운영 배포는 사용자 승인을 전제로 한다.

## Phase 1 — 기반 구조 ✅ (현재)

- [x] Next.js + TypeScript 프로젝트 초기화 (App Router, Tailwind)
- [x] 모바일 우선 다크모드 대시보드 기본 UI
- [x] 화면: 홈 · 프로젝트 · 에이전트 · 작업 · 활동
- [x] 에이전트 adapter 인터페이스 설계 (`AgentAdapter`)
- [x] Claude Code 1차 연결 대상 어댑터 스텁
- [x] GitHub Issue 기반 작업 큐(TaskQueue) 인터페이스 설계
- [x] 문서: README, AGENTS, ARCHITECTURE, ROADMAP

**완료 조건**: 로컬 실행, 타입 검사·빌드 통과, 샘플 모드 명시.

## Phase 2 — 실제 연결 (로컬)

- [ ] GitHub 작업 큐 구현 (Octokit, Issues/PR 읽기·쓰기) — *GITHUB_TOKEN 필요*
- [ ] 라벨 자동 생성/동기화 (`agent:*`, `status:*`, `project:*`)
- [ ] Claude Code CLI 실제 연결 검증 (`checkConnection` 구현)
- [ ] 대시보드를 샘플 데이터 → 실제 작업 큐 데이터로 전환
- [ ] 작업 생성/배정/상태 변경을 대시보드에서 수행

**선행 승인 필요**: GitHub 토큰 발급·설정.

## Phase 3 — 다중 에이전트 & 클라우드 실행

- [ ] Codex 어댑터 실제 연결
- [ ] Pickle 연결 (개인 데이터 수집/외부 작업)
- [ ] ChatGPT(PM) 연동 — 작업 자동 분배/검수 흐름
- [ ] 각 에이전트 `cloudCapable` 실측
- [ ] PC 종료 후에도 운영 가능한 클라우드 실행 구조 설계·검토

**선행 승인 필요**: 클라우드 호스팅·유료 서비스 사용 여부.

## 원칙

- 각 단계에서 실제로 검증된 것만 "완료"로 표시한다.
- 확인할 수 없는 상태·수치는 `unknown`으로 둔다.
- main 직접 변경 금지. 기능 브랜치 → PR → 검수 → 머지.
