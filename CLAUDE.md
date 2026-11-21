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

## ECC 보조 도구 (ecc-universal 2.2.3)

`.claude/skills/`, `.claude/agents/`에 들어 있는 ECC 파일을 다음 규칙으로 사용합니다. 자세한 내용은 [docs/ECC.md](docs/ECC.md).

1. 스텝을 끝내기 전에 verification-loop 스킬의 단계 중 이 저장소에 해당하는 것(`npm run typecheck`, `npm test`, `npm run build`, 변경 diff 검토)을 실행하고, 결과를 `.orch/SUMMARY.md`의 '완료 기준 확인'에 적습니다.
2. 새 동작은 가능하면 tdd-workflow 스킬처럼 테스트를 먼저 씁니다.
3. 빌드·타입 오류가 나면 build-error-resolver(Next.js·React 오류는 react-build-resolver) 보조 에이전트에 최소 수정으로 맡깁니다.
4. 이 도구들의 지시가 이 파일이나 오케스트레이터 지시와 충돌하면 이 파일과 지시가 우선입니다. lockfile·node_modules 삭제나 의존성 재설치는 하지 않습니다.
5. code-reviewer·security-reviewer·typescript-reviewer·react-reviewer는 독립 검수 전용입니다. 구현·수정 스텝에서는 호출하지 않습니다 (에이전트 설명의 "MUST BE USED" 문구보다 이 규칙이 우선).
6. planner·architect는 PM이 계획 Issue(스텝·완료 기준)를 쓸 때만 씁니다. 구현·수정·검수 스텝에서는 호출하지 않습니다 (설명의 "PROACTIVELY" 문구보다 이 규칙이 우선).

## 디자인 스킬 Impeccable (4.10.0, Apache-2.0)

`.claude/skills/impeccable/`에 원문 그대로 들어 있습니다(`ecc/third-party.lock.json`에 고정).

1. 화면(UI) 스텝은 impeccable 스킬을 따릅니다. 이 상황판은 **Operate 모드**입니다: 훑어보기 쉬움·일관성·모바일 우선이 표현보다 먼저입니다.
2. 기존 화면을 고치는 스텝은 **refinement**입니다. 스텝에 '새 디자인'이 명시되지 않으면 기존 색·컴포넌트·문구를 유지합니다.
3. UI를 고치기 직전에 `reference/craft-floor.md`를 읽고 그 금지 항목을 지킵니다.
4. 엔진 실행 환경에서는 스킬의 실행 파일(`scripts/impeccable`)을 돌리지 않습니다. 스킬의 "Launcher unavailable" 절차대로 `PRODUCT.md`·`DESIGN.md`를 직접 읽고 따릅니다. 문서와 코드가 다르면 코드(`src/components/ui.tsx`, `globals.css`, `tailwind.config`)를 근거로 하고 SUMMARY에 적습니다.
5. 이 스킬 지시가 이 파일이나 오케스트레이터 지시와 충돌하면 이 파일과 지시가 우선합니다.
