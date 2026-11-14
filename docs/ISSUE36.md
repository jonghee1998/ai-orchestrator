# Issue #36 — PM 기준 커밋에 묶인 구독 협업

기준은 PR #35 브랜치 `claude/laughing-lovelace-pzrezv`, SHA
`7ad5adbb3dbc3e01aeaae6b951f2f5cde213bc5d`이다. 보류된 Actions PR #37 코드는 사용하지 않는다.

## 실행 경계

- PM이 **repo / issue / baseBranch / baseSha / sourcePr / workBranch**를 명시한다. GitHub에서 기준 브랜치와 source PR HEAD가 지정 SHA에 일치하는지 GET으로 검증한 후 저장한다. 기준 브랜치가 움직이면 자동으로 새 기준을 채택하지 않는다.
- `reviewCompletedPr: true`는 완료된 Claude PR을 Codex 검수로 인계한다. false는 Claude 개발부터 시작한다.
- `Claude 완료 → Codex 검수 → PM 대기 → revise → Claude 수정 → Codex 재검수`를 같은 영구 저장소에서 처리한다. approve는 상태만 기록한다. **머지·배포를 실행하는 코드는 없다.**
- ChatGPT 구독을 백엔드에서 자동 호출할 지원 인터페이스는 없다. GPT 판단은 기존 ChatGPT 세션에서 수행하고 관리자가 인증된 `decide` 요청으로 전달한다. 완전 무인 GPT 판단이나 구독 연결 성공을 주장하지 않는다. 유료 모델 API / Actions 모델 호출을 추가하지 않는다.
- 서버는 기존 GitHub 라벨 어댑터를 사용한다. 라벨 전달 성공은 `submission: accepted`일 뿐 실제 실행 완료가 아니다. 기존 **외부 구독 루틴/스케줄러 소유자가 새 worker 명령을 연결해야 한다.** 라벨을 수동으로 붙이는 기존 우회 경로를 서버가 통제한다고 주장하지 않는다.

## 저장과 보안

PR #35의 per-agent HMAC, gate v2, replay/freshness 검증, agent/issue/dispatch 바인딩, OFF/provider/schedule 게이트, TLS 검증, 서버리스 파일 저장 금지를 유지한다.

워크플로·실행·후속 큐를 동일한 RunStore 트랜잭션에 저장한다. 운영에는 `DATABASE_URL`의 PostgreSQL 행 잠금을 사용한다. 파일 저장은 단일 Node 프로세스 개발용이며, 같은 프로세스의 여러 FileRunStore 인스턴스도 경로별로 직렬화한다. 여러 프로세스/호스트에서 파일 스토어를 공유하지 않는다. 기존 JSON/DB 스냅샷은 optional `collaborations` 필드를 통해 호환된다. 새 SQL 마이그레이션은 필요 없다.

작업 식별자는 workflow UUID + cycle + step이다. 제출 승인은 원자적으로 한 번만 획득하며, 승인 후 응답 유실/재시작 시 자동 재전송하지 않는다. worker claim도 한 번만 가능하다. 승인된 task만 claim할 수 있고, OFF 전환 시 새 claim/CLI 시작을 거부한다. 이미 실행 중인 worker는 drain하며 취소를 보장하지 않는다. 협업 작업은 다른 에이전트로 자동 reroute하지 않는다.

### #41 P1: 실행 불명 복구 펜싱 (fail closed)

timeout/blocked 상태 전환이나 PM의 `acknowledgeUnknownExecution`은 이미 실행 중인 CLI를 멈추지 않는다. 그래서 claim된 이전 실행이 **증명 가능하게 정지(quiescent)**하기 전에는 복구(`revise`)와 같은 workBranch의 새 Claude claim을 모두 `409 prior_execution_not_quiesced`로 거부한다. 이 검사는 claim 시점에도 적용하므로 refresh → 검수 → revise 경로로도 우회할 수 없다.

정지로 인정되는 경우는 다음 세 가지뿐이다.
1. claim되지 않은 채 종료된 step: 종료된 record는 더 이상 claim할 수 없다.
2. 구조화된 결과(finish)가 기록된 경우: runner는 CLI 프로세스 그룹이 비었음을 확인한 다음에만 finish를 보낸다.
3. runner가 서명해 보낸 `quiesce` 보고.

**Runner 계약 (`scripts/subscription-worker.mjs`):**
- CLI를 별도 프로세스 그룹의 리더로 실행한다.
- 60초마다 서명된 `lease`를 갱신하며, 이것이 heartbeat를 겸한다.
- 다음 경우에 SIGTERM을 보내고, 유예 후 SIGKILL로 그룹 전체를 종료한다.
  - 서버가 `revoked`를 반환한 경우: timeout, superseded, 복구 등.
  - 10분 동안 갱신에 실패한 경우: self-fence. 이 시간은 서버의 heartbeat timeout인 15분보다 짧다.
- 그룹이 비었음을 `kill(-pgid, 0)`의 ESRCH로 확인한 뒤에만 `quiesce`를 보고한다. 확인하지 못하면 보고하지 않으므로 복구는 계속 차단된다.
- 보고는 파일로 남겨 두며, 재전송할 때 finish-file 인자로 다시 보낼 수 있다.

**#49 (PR48 P1 x2): 정리 증명 필수.**
- runner는 실행마다 supervisor 하나를 두고, 자신이 시작한 **모든** 프로세스 그룹을 관리한다. 대상은 CLI와 각 테스트 명령(`npm run typecheck`, `npm test`)이다.
- lease가 revoke되거나 만료되면 그 시점에 활성인 그룹(CLI 또는 테스트)을 모두 종료한다. 이후에는 새 그룹을 시작하지 않는다.
- 모든 그룹은 리더가 정상 종료한 후에도 남은 후손을 정리하고, 그룹이 비었는지 확인한다.
- 그룹이 비었는지는 Linux에서 `/proc`으로 확인하며, 실행할 수 없는 zombie는 제외한다. 그 밖의 환경에서는 `kill(-pgid,0)`으로 확인한다.
- `finish`는 서명된 `result.cleanup = { processGroupsEmpty: true, groups }`가 있어야만 받는다.
  - 서버는 cleanup 증명이 있는 execution만 quiescent로 인정한다.
  - cleanup이 없는 기존 runner의 결과는 거부하거나 정지로 인정하지 않는다(fail closed).
- 한 그룹이라도 비었음을 증명하지 못하면(예: 신호가 거부되어 writer가 살아 있는 경우):
  - `finish`와 `quiesce`를 **둘 다 보내지 않는다**.
  - 진단 파일(`cleanupUnproven`)을 남기고, 서명된 `cleanup_failed`를 보낸 뒤 종료 코드 4로 끝난다.
  - 서버는 기록을 failed, blocked/execution_unknown으로 표시하지만 정지를 주장하지 않는다. 그래서 revise와 새 writer claim은 계속 `prior_execution_not_quiesced`로 거부된다.
- 진단 파일을 재전송할 때는 기록된 pgid를 **probe만** 하고 신호는 보내지 않는다. pgid가 재사용되었을 수 있기 때문이다.
  - 그룹이 아직 살아 있으면 계속 보내지 않는다.
  - 모두 사라졌으면 `quiesce(reason: cleanup_retry)`를 보내고, 그때서야 복구할 수 있다.
- `ORCH_TEST_DENY_GROUP_SIGNALS=1`은 회귀 테스트 전용이다. 신호만 실패시키고 probe는 실제 프로세스 테이블을 보므로 증명을 만들어 낼 수 없다.

**한계:**
- setsid/daemonize로 그룹을 벗어난 후손 프로세스는 다루지 않는다.
- runner가 직접 실행하는 짧은 `git` 조회(status/rev-parse/remote/branch, hook 없음)는 supervisor 밖에서 실행된다.
- 이미 저장된 기존 execution(cleanup 증명 없음)은 quiescent로 인정되지 않는다. 해당 workflow에서 새 writer를 시작하려면 PM이 수동으로 확인해야 한다.
- 계약 밖의 경로(수동 라벨 우회, 구버전 runner)는 서버가 통제하지 못한다.
- 원격 브랜치 보호를 이용한 쓰기 차단(GitHub fencing)은 구현하지 않았다.
- 취소를 주장하지 않으며, 근거는 runner의 서명된 증명뿐이다.

성공에는 실제 CLI 종료 코드, 1개 이상의 테스트 종료 코드, 검증된 GitHub PR HEAD가 필요하다. GitHub compare로 결과 커밋이 PM 기준 SHA를 포함하는지도 검증한다. 검수 결과는 해당 PR 번호와 SHA에 묶인다. 서버가 확인하는 것은 서명된 worker 보고와 GitHub 증거이며 테스트 결과를 서버가 독립 재실행했다고 표시하지 않는다. 결과/요약에 인증정보나 원문 환경변수를 넣지 않는다.

## 서버 API

기존 `.env.example` 설정을 사용한다: GITHUB_REPO, GITHUB_READ_TOKEN(또는 GITHUB_TOKEN),
GITHUB_TOKEN(Issues 라벨 쓰기), CONTROL_ADMIN_TOKEN, CONTROL_READ_TOKEN,
RUN_CALLBACK_SECRET_CODEX / RUN_CALLBACK_SECRET_CLAUDE_SONNET 또는 _CLAUDE_OPUS, 영구 저장소.
네트워크는 `api.github.com`과 Git HTTPS 접근이 필요하다. 모델 API 키는 필요 없다.

`GET /api/collaboration`은 read/admin 토큰으로 워크플로, 최신 PR/커밋, 단계와 인계 이력을 조회한다.
`GET /api/runs` 및 활동 화면은 기준 SHA, 실행 SHA, 실제 종료 코드/테스트/요약을 표시한다.

`POST /api/collaboration`은 `x-admin-token`이 필요하다. 예시 본문:

```json
{
  "action": "assign",
  "assignment": {
    "repo": "jonghee1998/ai-orchestrator",
    "issueNumber": 36,
    "baseBranch": "claude/laughing-lovelace-pzrezv",
    "baseSha": "7ad5adbb3dbc3e01aeaae6b951f2f5cde213bc5d",
    "sourcePr": 35,
    "workBranch": "claude/issue-36-fixes",
    "claudeAgent": "claude-sonnet",
    "instructions": "PM이 지정한 요구사항과 보안 게이트를 검수하고 발견한 문제를 보고한다.",
    "reviewCompletedPr": true
  }
}
```

같은 repo/issue 재할당은 거부한다. 응답은 workflow와 별도의 submission 결과다.
게이트가 OFF이면 큐는 held 상태로 남으며 ON 이후 관리자가 다음 요청으로 제출한다:

```json
{"action":"submit","dispatchId":"응답에 기록된 ID"}
```

외부 스케줄러는 새 커밋 감지를 위해 기존에 추적 중인 PR을 주기적으로 갱신할 수 있다:

```json
{"action":"refresh","workflowId":"할당된 UUID"}
```

HEAD가 그대로면 새 실행을 만들지 않는다. 변경되면 이전 검수/PM 판단을 무효화하고 새로운 SHA에 대한 Codex 검수를 한 번 큐에 넣는다. 이전 실행이 진행 중이면 superseded로 기록하며 프로세스 자체를 중단했다고 표시하지 않는다. source PR 기준 SHA 자체가 바뀌면 `unrelated_pr`로 중단하며 PM의 새 기준 지정이 필요하다.

GPT가 실행 결과를 읽고 판단한 뒤 명시적으로 전달한다:

```json
{"action":"decide","workflowId":"할당된 UUID","sha":"검수된 전체 SHA","decision":"revise","feedback":"수정할 구체적 내용"}
```

`decision`은 approve 또는 revise. 오래된 판단/중복 판단은 거부된다. GitHub HEAD가 검수 후 바뀌면 approve하지 않고 재검수한다. 실패/테스트 없음은 blocked가 되며, PM은 revise만 요청할 수 있다. 승인으로 실패를 덮어쓸 수 없다. 전송 결과가 unknown인 실행 자체를 자동 재시도하지 않는다.

## 외부 구독 루틴 연결

기존 Claude Code / Codex CLI에 **구독 로그인**한 호스트에서 사용한다. CLI 사용 권한/한도와 도구 허용 정책은 소유자가 관리한다. API 키 로그인, `--dangerously-*`, 샌드박스 우회 옵션은 사용하지 않는다. 이 저장소에 CLI 로그인 자격증명을 복사하지 않는다.

각 클라우드 task는 이미 격리돼 있다. 기존 task 체크아웃을 사용하고 별도 worktree를 자동 생성하지 않는다. worker에는 기준/검수 SHA와 일치하는 깨끗한 체크아웃을 제공한다. 코드가 필요한 task 디렉터리는 기존 절차로 준비한다. Claude 개발은 지정된 workBranch, Codex 검수는 별도 task 브랜치/분리 HEAD에서 수행하며 main/master/기준 브랜치에서는 실행을 거부한다. runner는 checkout/reset/clean으로 사용자 파일을 덮어쓰지 않는다.

예: 외부 루틴이 응답의 dispatchId와 대상 SHA를 읽어 task 체크아웃을 준비한 뒤:

```sh
# ORCH_URL 및 해당 에이전트의 GATE_SECRET은 호스트의 보안 환경으로 주입
node scripts/subscription-worker.mjs codex 36 '<dispatchId>' /path/to/task-checkout
```

Claude는 첫 인자를 claude-sonnet 또는 claude-opus로 바꾼다. worker는 다음을 실행한다:

1. per-agent HMAC으로 `/api/collaboration/worker`에 단일 claim. 서명된 응답의 issue/agent/run/dispatch 바인딩 확인.
2. 원격 repo / 깨끗한 체크아웃 / 정확한 SHA / 작업 브랜치 확인.
3. CLI 호출 직전에 **기존 `/api/gate` v2**의 서명된 task별 allow 재확인.
4. `codex exec --sandbox read-only --output-last-message ...` 또는 `claude --print --model sonnet|opus` 실행. API 키와 orchestrator 비밀은 자식 환경에서 제거한다. 머신의 CLI가 구독 인증을 쓰는지는 소유자가 확인해야 한다.
5. 실제 `npm run typecheck`, `npm test` 실행. structured CLI summary + PR 번호 + git HEAD + 종료 코드 기록.
6. `.git/orchestrator/<runId>.json`에 결과를 먼저 저장한 후 서명된 완료 보고. 서버가 GitHub에서 PR과 SHA를 검증하고 후속 단계를 제출한다. PR은 동일 저장소의 지정 작업 브랜치에서 기준 브랜치를 대상으로 해야 하며 fork PR은 지원하지 않는다.

CLI가 실패하거나 보고 JSON을 만들지 못하면 성공으로 취급하지 않는다. 프로세스 중단/불명확한 ACK는 타임아웃/unknown으로 남기며 CLI를 자동 재실행하지 않는다. 완료 보고 응답이 유실됐을 때는 동일 결과 파일을 재전송할 수 있다:

```sh
node scripts/subscription-worker.mjs codex 36 '<dispatchId>' /path/to/task-checkout /path/to/.git/orchestrator/<runId>.json
```

이 모드는 CLI와 테스트를 다시 실행하지 않는다. PR이 이미 바뀌었다면 stale 결과는 거부된다. scheduler는 refresh를 수행하고 최신 검수 task를 인계한다. 서버의 signed worker API는 `v:2, agent, issueNumber, dispatchId, runId, action:claim|finish`를 서명된 본문에 요구한다. 기존 `/api/runs/callback`은 협업 작업에 heartbeat만 허용한다.

## 검증

```sh
npm ci --cache /tmp/ai-orchestrator-npm-cache --no-audit --no-fund
npm run typecheck
npm test
npm run build
```

테스트는 메모리/파일 저장소 및 HTTP/CLI 대역으로 pin 검증, 동시 제출/claim, OFF, 구독 협업 전이, PR HEAD 변경, 서명 위조/재생, 실행 실패, 결과 재전송을 확인한다. 실제 CLI 구독 세션/GitHub 운영 쓰기/운영 DB의 성공을 이 테스트가 증명하지는 않는다. `TEST_DATABASE_URL` 미설정이면 실제 PG 테스트 2개는 skip이다.
