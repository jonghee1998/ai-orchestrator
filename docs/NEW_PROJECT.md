# 새 프로젝트 시작 절차

> **원칙: 아래 1→2→3→4 순서를 지키지 않으면 작업(계획 Issue 승인 요청·구현)을 시작하지 않습니다.**

공통 운영 방법은 [ORCH_MANUAL.md](ORCH_MANUAL.md)에 있고, 이 문서는 새 저장소를 오케스트레이터에 올리는 순서만 적습니다. 참고 예시: [jonghee1998/Personal-dashboard](https://github.com/jonghee1998/Personal-dashboard).

| 단계 | 누가 | 끝난 기준 |
| --- | --- | --- |
| 1. 기본 환경 | 사용자(저장소·Secrets·설정) + PM(파일 설치) | 엔진·CI가 돌고 상황판에 프로젝트 카드가 보이며 AI 팀 탭에 '값이 다름'이 없음(8번 스위치를 기존 프로젝트와 같게 넣은 뒤 확인), main 보호 규칙에 CI 잡이 필수 검사로 지정됨 |
| 2. 상황판 진행 단계 | PM | 프로젝트 탭에 인프라 체크리스트와 진행 단계가 보임 |
| 3. 아키텍처 확인 | PM 작성 → 사용자 확인 | 구조 탭에서 사용자가 "확인"이라고 답함 |
| 4. 작업 시작 | PM → 사용자 승인 → AI 팀 | 진행 단계 순서대로 계획이 반영됨, `docs/PM_HANDOFF.md`가 최신 |

## 1. 기본 환경

- **누가**: 저장소 생성·Secrets·GitHub 설정·상황판 서버 설정은 사용자, 엔진·문서 파일 복사는 PM.
- **끝난 기준**: 첫 PR에서 `ci`가 통과하고, main 보호 규칙에 CI 잡이 필수 검사(required status checks)로 지정되어 있고, 8번의 스위치 변수(`ORCH_AUTO` 포함)를 기존 프로젝트와 같게 넣은 뒤 상황판 프로젝트 탭에 새 카드가, AI 팀 탭에 '일부 프로젝트 값이 다름' 표시가 없음.

1. **저장소 생성** — 공개/비공개를 정합니다.
   - 실데이터(개인정보·실제 주소·키)가 들어갈 수 있으면 비공개.
   - 공개 저장소는 GitHub Actions 시간이 무제한, 비공개는 월 한도가 있으므로 엔진이 자주 도는 프로젝트는 공개가 유리합니다. 공개로 할 때는 문서·테스트 픽스처에 실데이터를 쓰지 않습니다.
2. **엔진 설치** — 기존 프로젝트에서 그대로 복사합니다.
   - `scripts/orch/` 전체와 `.github/workflows/`의 엔진 워크플로 13개: `claude-review.yml`, `claude-work.yml`, `cleanup-branches.yml`, `codex-login.yml`, `final-sync.yml`, `idea-review.yml`, `orchestrator.yml`, `plan-next.yml`, `plan-review.yml`, `plan-revise.yml`, `pm-unblock.yml`, `usage.yml`, `wait.yml`.
     - 선택: `deploy.yml` — Vercel Deploy Hook으로 운영 배포하는 프로젝트만 설치하고, 이때 저장소 Secret `VERCEL_DEPLOY_HOOK`을 함께 설정합니다. 시크릿 없이 설치하면 main 반영 때 배포 잡이 실패합니다.
   - `ci.yml`: 워크플로 `name`을 **`ci`**로 둡니다. `orchestrator.yml`의 `workflow_run`이 이 이름의 워크플로가 끝날 때 엔진을 깨우기 때문입니다. 최종 판정은 이름이 아니라 PR head 커밋(head SHA)에 생긴 check run 결과(엔진 자체 검사 advance·work·publish 제외)로 하므로, `ci.yml`은 `pull_request`에서 돌아 PR head SHA에 check run을 남겨야 합니다(check run이 하나도 없으면 엔진이 계속 기다립니다). 테스트와 함께 개인정보 검사 단계(실데이터·키 값이 커밋되지 않았는지)를 넣습니다.
   - Python 패키지가 필요한 프로젝트: 저장소 루트에 `requirements.txt`를 두면 구현·검수 환경(claude-work·claude-review)이 Python 3.12를 준비하고 `pip install -r requirements.txt`를 실행합니다. 구현 AI는 `python3`를 실행할 수 있고, `npm test`가 pytest를 함께 돌리게 하면 CI·검수가 같은 기준을 씁니다. `requirements.txt`가 없으면 이 단계는 건너뜁니다.
3. **CLAUDE.md·AGENTS.md** — 구현 Claude와 Codex 검수가 읽는 규칙. 이 저장소 파일을 기준으로 스택·수정 금지 경로만 바꿉니다.
4. **Secrets** — 설정 위치와 권한은 [ORCH_MANUAL 8장 '처음 한 번 설정'](ORCH_MANUAL.md#8-처음-한-번-설정-저장소마다) 표를 따릅니다: `CLAUDE_CODE_OAUTH_TOKEN`, `BOT_PAT`, `CODEX_AUTH_KEY`(Codex 사용량, [사용량](ORCH_MANUAL.md#사용량은-어떻게-재나요) 절), `NTFY_TOPIC`(선택).
5. **외부 PR 승인 설정** — Settings → Actions → General에서 외부 기여자 PR의 워크플로는 승인 후에만 실행되게 둡니다(공개 저장소 필수).
6. **라벨** — `orch:*` 라벨은 첫 실행 때 자동 생성되지만, 사용자가 처음 `orch:go`를 붙이려면 미리 있어야 합니다. **라벨이 없으면 PM이 만듭니다.**
7. **상황판 등록** — 상황판 서버 설정 `ORCH_REPOS`에 저장소를 추가하고, `ORCH_GITHUB_TOKEN`에 새 저장소 권한을 더합니다. 필요한 권한은 [ORCH_MANUAL 10장 토큰 권한 표](ORCH_MANUAL.md#10-모바일-상황판-ai-orchestrator-앱)를 따릅니다.
8. **스위치 초기화** — 새 저장소의 `ORCH_SONNET`·`ORCH_OPUS`·`ORCH_CODEX`·`ORCH_PAUSED`·`ORCH_WINDOW`·`ORCH_AUTO`·`ORCH_CODEX_DEV`는 **상황판 스위치(전체 쓰기)를 쓰지 않고**, 그 저장소의 Settings → Secrets and variables → Actions → Variables([ORCH_MANUAL 4장](ORCH_MANUAL.md#4-끄고-켜기-onoff))에서만 기존 프로젝트와 같은 값으로 넣습니다. 상황판 스위치는 등록된 모든 프로젝트에 적용되어 기존 프로젝트 설정까지 바꾸기 때문입니다. 넣은 뒤 상황판 AI 팀 탭에서 '값이 다름' 표시가 없는지 확인합니다. `ORCH_AUTO`는 기본이 off이므로 기존 프로젝트가 on이면 새 저장소에도 on으로 넣어야 값이 같아지고 4장의 자동 시작이 동작합니다.
9. **main 보호·필수 검사** — 저장소 Settings → Rules(또는 Branches)에서 main 규칙을 만들어 삭제·강제 push를 막고, 필수 검사(required status checks)에 그 프로젝트 `ci.yml`의 잡 이름을 지정합니다(이 저장소 예: `test`·`screens`). 엔진은 최종 PR head SHA에 그 시점까지 등록된 check run만 보고 판정하므로(`scripts/orch/main.mjs` evaluateFinal → `core.mjs` ciVerdict), 프로젝트 CI가 아직 등록되지 않았을 때 다른 검사만 성공해 있으면 머지를 시도할 수 있고, 필수 검사가 이 머지를 막습니다. 사람이 확인하는 항목은 [보안 점검표](SECURITY_CHECKLIST.md)의 'main 브랜치 보호 (필수 검사 포함)'입니다.

## 2. 상황판 진행 단계

- **누가**: PM.
- **끝난 기준**: 프로젝트 탭 카드에 '0 인프라 완료/전체'와 '단계 완료/전체', 진행 단계 목록이 보임.

1. `docs/roadmap.json`을 만듭니다(형식은 [ORCH_MANUAL 10장](ORCH_MANUAL.md#10-모바일-상황판-ai-orchestrator-앱)).
   - `setup`: 인프라 체크리스트 — 1단계에서 한 일(저장소·엔진·토큰·Codex·CI 등)을 항목마다 done·doing·todo·na로.
   - `phases`: 프로젝트 단계. 각 단계 `note`에 **'AI: … · 나: …'**(AI 팀이 할 일과 사용자가 할 일), 사용자 몫의 세부 할 일은 `tasks`(owner `me`·`ai`).
2. 작업 연결: 계획 JSON 최상위에 `"phase": "단계 id"`를 적으면 그 단계 묶음에 들어갑니다. `phase`로만 이어진 단계는 자동 완료되지 않으므로 끝나면 PM이 `status`를 done으로 바꿉니다.

## 3. 아키텍처 확인

- **누가**: PM이 쓰고, 사용자가 상황판 구조 탭에서 확인.
- **끝난 기준**: 사용자가 구조 탭의 이 프로젝트 카드를 보고 확인함. **확인 전에는 작업 계획을 승인 요청하지 않습니다.**

`docs/architecture.json`을 씁니다. 구조 탭이 contents API로 읽어 프로젝트 카드(머리 = `purpose`, 펼치면 섹션)로 보여 줍니다. 섹션 `01`은 **목표 구조**이고, 오케스트레이터 팀(PM·구현·검수·CI)이 어디서 일하는지(예: GitHub Actions에서 구현·검수, 반영은 `main`)를 포함합니다.

### 형식 요약

```text
{ "version": 1,
  "purpose": 프로젝트 목적 한 줄,
  "sections": [ { "no": "01", "kicker": 분류, "title": 제목, "blocks": [블록…] } ] }

블록:
  { "type": "text",  "lines": [문장…] }
  { "type": "table", "head": [열…], "rows": [[칸…]…] }
  { "type": "diagram", "width": 300, "height": 정수, "label": 그림 설명,
    "boxes":  [{ "x", "y", "w", "h", "lines": [1~3줄], "tone": "plain" | "accent" | "deep" }],
    "arrows": [{ "points": [[x, y], [x, y]…] }],
    "caption": 범례 한 줄 }
```

| 제한 | 값 (넘으면) |
| --- | --- |
| 파일 크기 | 65,536바이트 초과 → 형식 오류 |
| 글자 수 | 목적 60·분류 12·제목 40·문장 120·표 칸 40·그림 설명 120·범례 80자 (자름), 상자 줄 18자 (말줄임표) |
| 개수 | 섹션 12·섹션당 블록 6·text 8줄·table 열 4×행 20·상자 24·화살표 30·화살표당 점 2~6 (넘는 것은 버림) |
| 좌표 | 유한한 숫자, `x ≥ 0`·`y ≥ 0`, `w`·`h` 양수, `x+w ≤ 300`, `y+h ≤ height`, `height`는 40~1200 정수, 점도 그림 안 → 아니면 그 상자·화살표만 버림 |
| 렌더 | 모든 문자열은 텍스트로만 표시 (HTML 해석 안 함) |

짧은 가짜 예시:

```json
{
  "version": 1,
  "purpose": "예시 앱: 할 일을 모아 보여 주는 화면",
  "sections": [
    {
      "no": "01", "kicker": "목표 구조", "title": "폰에서 보고 AI 팀이 만든다",
      "blocks": [
        { "type": "text", "lines": ["사용자는 폰으로 화면을 본다.", "AI 팀은 GitHub Actions에서 구현·검수하고 main에 반영한다."] },
        { "type": "diagram", "width": 300, "height": 80, "label": "요청에서 반영까지",
          "boxes": [
            { "x": 10, "y": 20, "w": 120, "h": 40, "lines": ["사용자", "요청·승인"], "tone": "plain" },
            { "x": 170, "y": 20, "w": 120, "h": 40, "lines": ["AI 팀", "Actions"], "tone": "accent" }
          ],
          "arrows": [{ "points": [[130, 40], [170, 40]] }],
          "caption": "화살표 = 요청 방향" },
        { "type": "table", "head": ["구성", "위치"], "rows": [["화면", "예시 호스팅"], ["엔진", "GitHub Actions"]] }
      ]
    }
  ]
}
```

## 4. 작업 시작

- **누가**: PM(계획·인수인계), Codex(계획 감사), 사용자(승인), AI 팀(구현·검수·CI).
- **끝난 기준**: 각 진행 단계의 계획이 반영되어 roadmap `phases`가 done이 되고, `docs/PM_HANDOFF.md`가 마지막 대화 내용으로 갱신됨.

1. 진행 단계 순서대로 진행합니다: **계획 → 감사 → 사용자 승인(`orch:go`) → 구현·검수 → 반영** ([ORCH_MANUAL 2장](ORCH_MANUAL.md#2-새-작업-시작하기)).
   - **자동 모드**(`ORCH_AUTO` 켜짐, [ORCH_MANUAL 자동 모드 절](ORCH_MANUAL.md#자동-모드-orch_auto-상황판-ai-팀-탭-스위치)): 감사 OK면 바로 시작합니다. 감사가 '수정 필요'면 PM이 계획을 고칩니다. (가) 계획을 실제로 바꾸면 다시 감사하고, (나) PM이 바꿀 것이 없다고 판단해 같은 계획을 내면 마지막 라운드 전이라도 기존 계획 그대로 시작하며, (다) 고친 계획을 제대로 쓰지 못하면(형식 오류 등) 마지막 라운드 전에는 멈추고 Issue에 사람 판단을 남깁니다. 마지막(3) 라운드에서는 고쳤든 못 고쳤든(못 고치면 기존 계획) 재감사 없이 시작합니다. 즉 감사가 '수정 필요'여도 기존 계획이 자동으로 시작될 수 있습니다. 이때 `orch:go`는 사람이 아니라 엔진이 소유자 계정 토큰 `BOT_PAT`로 붙이므로 아래 소유자 확인 규칙을 그대로 통과합니다. 최종 PR은 위험 등급과 상관없이 CI 통과 뒤 자동 반영됩니다.
2. 계획 Issue는 **저장소 소유자 계정으로 게시**해야 엔진이 시작합니다. 엔진은 Issue 작성자와 라벨을 붙인 사람이 모두 소유자인지 확인하므로, **승인 라벨 `orch:go`는 저장소 소유자만 붙입니다.**
3. PM은 프로젝트 시작 때 `docs/PM_HANDOFF.md`를 처음 만들고(목표·진행 단계·결정 사항·다음 할 일), 대화가 끝날 때마다 갱신합니다.
