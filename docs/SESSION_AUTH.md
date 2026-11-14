# Routine-session auth compatibility (#55)

상태: **코드+단위 테스트만.** 라이브 스모크, 배포, main 병합, 운영 DB 변경, 기존 루틴 변경 없음.

## 문제
- 기존 worker(`scripts/subscription-worker.mjs`)는 `GATE_SECRET`(HMAC 키)를 프로세스 env로 읽음. Claude 클라우드 환경의 일반 env는 비밀 저장 금지, **Network Secrets**는 특정 호스트로 나가는 요청에 프록시가 **정적 헤더**를 주입할 뿐 프로세스에는 노출되지 않음 → 세션은 HMAC 서명 불가.
- 루틴 세션 안에서 nested `claude --print` CLI 실행 가능 여부는 미검증. 본 설계는 nested CLI를 쓰지 않고 **루틴 세션 자체를 worker로** 취급한다.

## 설계: `POST /api/collaboration/session`
| 항목 | 내용 |
|---|---|
| 자격증명 | 에이전트별 전용 랜덤 토큰. 프록시가 `x-orch-session-token` 헤더로 주입(Sonnet/Opus 환경 각각 별도 값). |
| 서버 저장 | **해시만**: `SESSION_TOKEN_SHA256_CLAUDE_SONNET`, `SESSION_TOKEN_SHA256_CLAUDE_OPUS` (hex sha256). 평문 토큰 없음. |
| 격리 | `x-agent-key`의 해시와만 비교(Sonnet 토큰으로 Opus 불가). codex/gpt 불가. 두 에이전트 해시 동일, 또는 HMAC 비밀·admin/read/cron·GitHub 토큰과 동일 → **503 fail closed**. 미설정 → 503. |
| 재전송 방지 | 1회용 `x-event-id`(HMAC 이벤트와 같은 durable `events` 테이블 → 채널 간 재사용도 409) + `x-timestamp` ±5분. |
| 작업 바인딩 | 본문 `{v:1, action, agent, issueNumber, dispatchId, runId, targetSha}`. agent=토큰 agent, record의 agent/issue/dispatch 일치(아니면 409 `dispatch_mismatch`), `targetSha`=dispatch의 정확한 task HEAD(아니면 409 `stale_target_sha`). |
| 게이트 | `gate`/`claim`은 기존 `checkExternalGate`(제어 ON·provider·스케줄 + orchestrator가 승인한 live dispatch) 그대로. `claim`은 기존 원자적 단일 writer claim + #41 writer fence 그대로. |
| 액션 | `gate`(허가 + task 컨텍스트 반환), `claim`, `lease`(heartbeat), `finish`. `quiesce`/`cleanup_failed` → 400 `unsupported_for_session`. |
| 기존 엔드포인트 | `/api/gate`, `/api/collaboration/worker`, `/api/runs/callback`은 변경 없음, 세션 헤더 무시(헤더만으로 401 — 테스트). |

## 신뢰 경계 / 증거 구분 (중요)
- 정적 헤더는 **bearer 자격증명**이지 서명이 아님: "그 에이전트 환경에서 나간 요청"만 증명. 본문 무결성은 TLS, 응답은 서명 없음(세션이 검증 키를 가질 수 없음).
- record에 `runOrigin: "session"` 기록. 세션 run은 세션 채널만 lease/finish 가능, HMAC runner는 lease/finish/quiesce 불가(`origin_mismatch`) — 반대도 동일.
- 세션 `finish` 결과는 `execution.attestation: "external_session_self_report"`로 저장, `cleanup` 필드 **없음**(보내면 `invalid_result`). 테스트 결과/요약은 **자기 보고(미검증)**. 서버가 검증하는 것은 GitHub PR HEAD = headSha, workBranch/base 일치, baseline ancestry(기존 로직)뿐.
- **프로세스 정리 증명 없음**: 세션 run은 절대 `provablyQuiescent`가 되지 않는다. 따라서 세션 writer 이후 같은 workflow의 새 Claude writer claim / PM revise는 `prior_execution_not_quiesced`로 계속 차단(fence 우회 없음). Codex 리뷰 → PM approve 경로는 동작.

## 남은 차단 요소 / 소유자 결정
1. **세션 writer 이후 revise 불가**: 외부 세션 종료를 증명할 provider 측 증거(세션 상태 API 등)가 이 저장소에서 확인되지 않음. 대안은 (a) 수동 종료 확인을 PM 증거로 인정하는 별도 정책(현재 거부 — 인정 = fence 완화), (b) revise 시 새 workBranch로 새 workflow 할당. 소유자 결정 필요.
2. 토큰 발급/주입: 소유자가 `openssl rand -base64 48` 등으로 에이전트별 토큰 생성 → 해당 Claude 환경 Network Secrets에 ORCH 호스트 + 헤더 `x-orch-session-token` 설정 → Vercel에 `SESSION_TOKEN_SHA256_*`(sha256 hex)만 설정. 토큰 평문은 어디에도 커밋/로그 금지.
3. 프록시가 실제로 해당 헤더를 curl/fetch 요청에 주입하는지, 동일 호스트 다른 경로에도 주입되는지(무해하나 확인 권장)는 **미검증** — 라이브 스모크 승인 후 1회 확인.
4. 루틴 프롬프트 변경(아래)은 소유자만 가능. 이 세션은 기존 루틴을 변경하지 않음.

## 루틴용 호출 예 (소유자가 승인 후 루틴에 추가)
```
ts=$(date +%s%3N); eid="sess-$(cat /proc/sys/kernel/random/uuid)"
curl -sS -X POST "$ORCH_URL/api/collaboration/session" -H 'content-type: application/json' \
  -H 'x-agent-key: claude-opus' -H "x-timestamp: $ts" -H "x-event-id: $eid" \
  -d '{"v":1,"action":"gate","agent":"claude-opus","issueNumber":<N>}'
# allow:true 가 아니면 즉시 종료(라벨/댓글/브랜치 변경 금지). 이후 claim(runId=새 UUID, targetSha=task.targetSha) → lease 주기 → finish.
```
