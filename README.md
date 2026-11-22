# AI Orchestrator

계획 Issue를 스텝으로 나눠 AI가 구현·검수하는 GitHub 기반 오케스트레이터와, 그 진행 상황을 보는 모바일 상황판입니다.
PM은 Claude, 구현은 Claude Sonnet/Opus, 독립 검수는 Codex(안 되면 Claude Opus), 시작 승인과 위험한 변경의 머지는 사용자가 합니다.

## 구조 한눈에

| 위치 | 내용 |
|---|---|
| `scripts/orch/` + `.github/workflows/` | 오케스트레이터 엔진 (계획 → 스텝 구현 → PR → 검수·CI → 머지) |
| `src/app/` | 상황판 하단 5탭: 프로젝트·AI 팀·PM 브리핑·패치노트·구조, `/api/orch`, `/api/session` |
| `src/lib/orch/`, `src/components/orch/` | 상황판 데이터(GitHub 읽기)와 화면 |
| `src/lib/session/` | 관리자 1명 로그인 (비밀번호 해시, 세션·CSRF) |
| `src/lib/patchnotes.ts`, `docs/roadmap.json` | 패치노트·로드맵 데이터 |
| `scripts/screens/` | 화면 테스트 스크린샷 |
| `.claude/`, `ecc/` | 보조 도구 (ECC·Impeccable) |

## 주요 문서

- [docs/ORCH_MANUAL.md](docs/ORCH_MANUAL.md) — 운영 매뉴얼 (작업 시작, 역할, ON/OFF, 배포)
- [CLAUDE.md](CLAUDE.md) — 구현 규칙 · [AGENTS.md](AGENTS.md) — 검수 지침
- [docs/ADMIN_LOGIN.md](docs/ADMIN_LOGIN.md) — 관리자 로그인 설정
- [docs/ECC.md](docs/ECC.md) — 보조 도구
- [PRODUCT.md](PRODUCT.md) · [DESIGN.md](DESIGN.md) — 제품·디자인 기준

## 로컬 실행

```bash
npm ci
npm run dev        # http://localhost:3000
npm test           # 테스트 (npm run typecheck, npm run build 도 CI 에서 실행)
npm run screens    # 화면 스크린샷
```

환경 변수는 `.env.example`을 보고 `.env.local`에 적습니다. 토큰·비밀번호는 저장소에 커밋하지 않습니다.
