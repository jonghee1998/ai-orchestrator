# CLAUDE.md

이 저장소는 orchestrator가 Claude에게 스텝 단위로 일을 맡깁니다. 지시(prompt)에 적힌 작업 규칙이 이 파일보다 우선합니다.

- 지시받은 스텝만 구현합니다. 범위 밖 리팩터링은 하지 않습니다.
- 코드를 바꾸면 `npm test`로 확인하고, 새 동작에는 테스트를 추가합니다.
- `.github/`와 `scripts/orch/`는 수정하지 않습니다. 수정하면 오케스트레이터가 푸시를 거부합니다.
- git push, 브랜치 생성, PR 생성은 하지 않습니다.
- 끝나면 `.orch/SUMMARY.md`에 변경 요약과 완료 기준 확인 결과를 적습니다.
- 진행할 수 없으면 `.orch/BLOCKED.md`에 이유를 적고 멈춥니다.

## 이 저장소 추가 규칙

- Next.js 15 + TypeScript. 코드를 바꾸면 `npm run typecheck`와 `npm test`를 둘 다 통과시킵니다 (CI는 `npm run build`도 실행합니다).
- 인증(`src/lib/session`, `src/app/api/_auth.ts`, `src/lib/control/auth.ts`)과 DB 마이그레이션(`db/migrations`)은 지시에 명시된 경우에만 수정합니다.
- 토큰·비밀번호·개인정보를 코드, 테스트 픽스처, 로그에 넣지 않습니다.
- 운영 방식은 [docs/ORCH_MANUAL.md](docs/ORCH_MANUAL.md)를 따릅니다.
