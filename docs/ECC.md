# ECC 보조 도구

## 도입 버전

- 패키지: `ecc-universal@2.2.3` (GitHub `affaan-m/ECC` 태그 `v2.2.3` = `c05b2d6`, MIT)
- 파일 원문을 수정 없이 복사했고, 버전·해시는 `ecc/ecc.lock.json`에 고정합니다 (`scripts/ecc-lock.test.mjs`가 검증).

## 들어간 파일

| 종류 | 경로 |
| --- | --- |
| 스킬 | `.claude/skills/verification-loop/SKILL.md` |
| 스킬 | `.claude/skills/tdd-workflow/SKILL.md` |
| 에이전트 | `.claude/agents/build-error-resolver.md` |
| 에이전트 | `.claude/agents/react-build-resolver.md` |
| 검수 에이전트 | `.claude/agents/code-reviewer.md` |
| 검수 에이전트 | `.claude/agents/security-reviewer.md` |
| 검수 에이전트 | `.claude/agents/typescript-reviewer.md` |
| 검수 에이전트 | `.claude/agents/react-reviewer.md` |
| 계획 에이전트 | `.claude/agents/planner.md` |
| 계획 에이전트 | `.claude/agents/architect.md` |

검수 에이전트 4종은 Codex 대신 Opus가 검수할 때(`claude-review`) 보조 검토로 씁니다. 검수 세션은 PR이 아니라 `main`의 `.claude/`를 쓰므로, 구현자가 PR에서 검수 지시를 바꿀 수 없습니다. 최종 판정(PASS/FAIL)은 Opus 본인이 내리고, 사용한 에이전트는 검수 댓글의 '도구 사용'에 자동 기록됩니다.

계획 에이전트 2종(planner, architect)은 PM이 계획 Issue를 쓸 때 스텝 분할·완료 기준·설계 위험을 점검하는 데 씁니다. 구현·검수 스텝에서는 쓰지 않습니다(CLAUDE.md 규칙 6).

보류: ECC 2.2.3에는 `change-impact` 스킬이 없고, `security-scan`은 외부 패키지(AgentShield)를 `npx`로 내려받아야 해서 넣지 않았습니다. 보안 점검은 검수 단계의 `security-reviewer`가 맡습니다.

사용 규칙은 [CLAUDE.md](../CLAUDE.md)의 'ECC 보조 도구' 절을 따릅니다.

## 넣지 않은 것과 이유

훅, 메모리, rules 전체 설치는 하지 않았습니다. 훅·메모리는 오케스트레이터 동작과 충돌하거나 상태를 몰래 바꿀 수 있고, rules 전체는 이 저장소의 CLAUDE.md 규칙과 겹쳐 지시 우선순위를 흐립니다. npm 설치도 `--ignore-scripts --no-save`로만 하여 `package.json`·`package-lock.json`을 바꾸지 않습니다. 배경과 결정은 [#198](https://github.com/jonghee1998/ai-orchestrator/issues/198)을 참고합니다.

## 효과 측정 방법

도입 전후 같은 기간·비슷한 크기의 run을 비교합니다.

- 검수 실패율: 스텝 중 검수에서 반려된 비율
- 수정 횟수: 스텝당 수정 요청·재시도 횟수

도입 후 두 값이 낮아지지 않으면 규칙을 줄이거나 제거합니다.
