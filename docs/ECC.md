# ECC 보조 도구

## 도입 버전

- 패키지: `ecc-universal@2.2.3` (GitHub `affaan-m/ECC@4adeee6`, MIT)
- 파일 원문을 수정 없이 복사했고, 버전·해시는 `ecc/ecc.lock.json`에 고정합니다 (`scripts/ecc-lock.test.mjs`가 검증).

## 들어간 파일

| 종류 | 경로 |
| --- | --- |
| 스킬 | `.claude/skills/verification-loop/SKILL.md` |
| 스킬 | `.claude/skills/tdd-workflow/SKILL.md` |
| 에이전트 | `.claude/agents/build-error-resolver.md` |
| 에이전트 | `.claude/agents/react-build-resolver.md` |

사용 규칙은 [CLAUDE.md](../CLAUDE.md)의 'ECC 보조 도구' 절을 따릅니다.

## 넣지 않은 것과 이유

훅, 메모리, rules 전체 설치는 하지 않았습니다. 훅·메모리는 오케스트레이터 동작과 충돌하거나 상태를 몰래 바꿀 수 있고, rules 전체는 이 저장소의 CLAUDE.md 규칙과 겹쳐 지시 우선순위를 흐립니다. npm 설치도 `--ignore-scripts --no-save`로만 하여 `package.json`·`package-lock.json`을 바꾸지 않습니다. 배경과 결정은 [#198](https://github.com/jonghee1998/ai-orchestrator/issues/198)을 참고합니다.

## 효과 측정 방법

도입 전후 같은 기간·비슷한 크기의 run을 비교합니다.

- 검수 실패율: 스텝 중 검수에서 반려된 비율
- 수정 횟수: 스텝당 수정 요청·재시도 횟수

도입 후 두 값이 낮아지지 않으면 규칙을 줄이거나 제거합니다.
