# 공통 테스트·증거 매트릭스 (v1)

테스트 케이스는 코드 작성 **전에** 범위와 예상 결과가 정의되어야 한다. 작성된 테스트의 개수가 아닌, 검증된 불변 조건과 실제 경로를 기준으로 판단한다.

| ID | 이벤트 / 입력 조건 | 필수 기대 결과 | 검증 수준 |
|---|---|---|---|
| E01 | PR 링크 루트 A→B, A/B에 sibling green | A와 B의 대상 PR 둘 다 기존 PASS 무효화·재평가 | 생성 테스트 + 실제 이벤트 |
| E02 | A→B와 root 마커 삭제 동시에 | 이전 루트 보존 증거 재조회, 불가 시 superset/BLOCKED; A green 유지 금지 | 부정 테스트 |
| E03 | 루트/수정 Issue 마커 삭제·모순·수정 | 영향 PR 전파; 무관함으로 오판 금지 | 통합 |
| E04 | PR/Issue/댓글 편집·삭제, 재배치 | fingerprint 변경·필수 체크 재실행 | 실제 이벤트 |
| E05 | API 403/404/5xx, pagination 누락, 대상 상한 초과 | 조용한 empty/PASS 금지, 명시적 BLOCKED | fault injection |
| E06 | 이벤트 중복·역순·동시 처리·HEAD race | 동일 스냅샷 불변, 과거 PASS 부활 금지 | 속성/메타모픽 |
| E07 | invalidation 첫 context 완료, 두 번째 실패 | 잠깐의 오래된 green이 승인에 이용되지 않도록 차단 및 운영 장애 보고 | 실행 경로 |
| E08 | 서로 다른 PR 두 개가 동일 SHA 사용, 하나 PASS 하나 FAIL | 공유 SHA의 필수 컨텍스트가 FAIL/BLOCKED; 서로 덮어쓰지 못함 | property + 통합 |
| E09 | 동일 SHA 자체 테스트 PASS와 FAIL 공존 | 임의 PASS 선택 금지 | 부정 테스트 |
| E10 | 동일 SHA 코드/보안 검수 충돌·중복·미검증 | PASS 금지 | 부정 테스트 |
| E11 | 사전 분석 댓글을 첫 코드 커밋 후 편집 | 사전 기록으로 인증 금지 | 타이밍 검증 |
| E12 | 기존 수정 n 기록 전/후 같은 PR 재평가 | 정당한 요청은 안정 판정, 위조·모순은 BLOCKED | runLifecycle |
| E13 | 별도 수정 Issue/댓글/PR 본문 기록 분산 | root 누적 이력 보존, 조회 누락 차단 | 실제 entrypoint |
| E14 | PM dispatch → Claude ACK만 / START / PR | ACK ≠ START, 세션+SHA+결과를 각각 검증 | 실제 provider |
| E15 | Codex FAIL → 자동 수정 → 재검수 PASS | 새 PR/SHA, 올바른 재배정, 1 writer | 실제 provider |
| E16 | 일반 root 수정3 소진 | 해당 root BLOCKED→사용자 협의, 타 root 지속 | 실제 이벤트 |
| E17 | 새 기능 추가 중 기존 실패 PR | 신규 범위 분리, 기존 실패 이력 보존 | 통합 |
| E18 | default-branch issue_comment, 필수 체크, 보안 검수 | 실제 main 활성화/보안 PASS가 없으면 E2E 미완료 | GitHub live |

## 테스트 방법
1. **참조 모델/Oracle**: 입력 EvidenceSnapshot/old+new roots/HEAD와 기대 AffectedSet·Verdict·PublishedStatus를 독립적으로 구현/검토. 구현 자체를 그대로 복사한 테스트 금지.
2. **속성 기반 테스트**: 이벤트 순열, 중복, 삭제/복구, 공유 SHA PR 쌍, 노드/엣지 변경의 조합 생성. seed·최소 반례 저장.
3. **실행 경로 테스트**: `handleEvent → targetsFromEvent → refreshPr → runCheck`, `runLifecycle`, GitHub Actions 조건/권한 검증. 대상 PR 목록만 맞는 테스트로 충분하지 않다; **발행된 두 상태 컨텍스트**를 확인한다.
4. **실제 E2E**: 별도 안전한 테스트 대상(허가된 브랜치/PR)에서 실제 GitHub Actions, 실행 세션, 독립 검수, 사용자 승인 대기까지 기록. 마이그레이션/설정 미승인 시 미검증 보고.
5. **증거 표**: 각 행마다 결과 PASS/FAIL/NOT_RUN, run URL, 실제 SHA, 리뷰 URL, 책임자 기록. 수동으로 PASS 체크만 하지 않는다.

## 완료 정의
필수 시나리오에 대해 참조 모델·단위/통합·실제 E2E 결과가 일치하고, 보안 및 승인 정책이 충족될 때만 시스템 완료. 신규 반례 발견 시 이 매트릭스에 추가하고 해당 결함과 유사 경로를 통합 검토한다.
