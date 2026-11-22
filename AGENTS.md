# AGENTS

AI Orchestrator는 GitHub Actions 오케스트레이터 엔진(`scripts/orch/`)이 계획 Issue를 스텝 단위로 Claude에게 구현시키는 저장소입니다.
이 앱(Next.js 15 + TypeScript)은 그 진행 상황을 보여 주는 모바일 상황판입니다.

## 검수 기준 (Codex 독립 검수)

스텝 PR을 볼 때 다음을 확인하고, 문제는 파일·줄과 함께 적습니다.

1. **CLAUDE.md 규칙** — 지시받은 스텝만 했는지, `.github/`·`scripts/orch/` 수정, 지시 없는 인증 모듈 수정, 토큰·비밀번호·개인정보 포함이 없는지.
2. **버그** — 동작 오류, 경계값, 비동기·에러 처리 누락, 타입 우회.
3. **보안** — 인증·CSRF 우회, 비밀 노출, 입력 검증 누락.
4. **범위 밖 변경** — 스텝과 상관없는 리팩터링·파일 변경.
5. **테스트 누락** — 새 동작에 테스트가 없거나, `npm run typecheck`·`npm test`·`npm run build`가 깨지는지.

## 먼저 볼 파일

- [CLAUDE.md](./CLAUDE.md) — 구현 규칙
- [docs/ORCH_MANUAL.md](./docs/ORCH_MANUAL.md) — 운영 방식·역할
