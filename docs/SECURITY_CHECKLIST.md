# 보안 점검표 (0.18 보안 검증)

코드·CI 항목은 근거 칸의 `경로` › "테스트 이름"이 실제 테스트와 글자 그대로 일치해야 하며, `scripts/security-checklist.test.mjs`가 `npm test`에서 이를 검사합니다.
운영 설정 항목은 코드로 확인할 수 없어 사람이 확인 위치에서 직접 봅니다. 이 문서에는 토큰·비밀번호·주소 같은 값을 적지 않습니다.

| 항목 | 구분 | 근거 | 상태 |
| --- | --- | --- | --- |
| 로그인 실패 5회 뒤 429·Retry-After (맞는 비밀번호도 제한, 만료 후 초기화) | 코드·CI | 테스트: `src/lib/session/admission.test.ts` › "wrong-password throttling: five failures then 429 with Retry-After, even for the right password; expiry resets" | 자동 검사 |
| 로그인 제한 우회 방지: x-forwarded-for·x-real-ip·Forwarded 세 헤더를 위조해도 제한 버킷을 바꿀 수 없음 | 코드·CI | 테스트: `src/lib/session/admission.test.ts` › "forwarded headers are not trusted: spoofing x-forwarded-for / x-real-ip / forwarded cannot rotate buckets" / 코드: `src/lib/session/rate-limit.ts`(clientKey) — x-vercel-forwarded-for는 신뢰 프록시 설정(VERCEL=1 또는 LOGIN_TRUST_PROXY=vercel)일 때만 클라이언트 IP로 쓰이며, 그 신뢰는 플랫폼(Vercel)이 이 헤더를 매 요청 덮어쓴다는 운영 조건에 의존함 | 자동 검사 |
| 세션 쿠키 HttpOnly·Secure·SameSite, 원문 토큰 미노출 | 코드·CI | 테스트: `src/lib/session/session.test.ts` › "login with admin token issues HttpOnly Secure SameSite cookie; no raw token anywhere" / 코드: `src/lib/session/http.ts` | 자동 검사 |
| 쿠키 인증 변경 요청의 CSRF (x-csrf-token 일치·같은 Origin) | 코드·CI | 테스트: `src/lib/session/session.test.ts` › "guard CSRF: cookie-auth mutation requires matching x-csrf-token and same Origin" / 코드: `src/lib/session/guard.ts`(authorize) | 자동 검사 |
| read 역할은 admin 작업 불가, 서명 없는 쿠키 거부 | 코드·CI | 테스트: `src/lib/session/session.test.ts` › "guard: session reads allowed; read-role cannot do admin; unsigned cookie rejected" / 코드: `src/lib/session/guard.ts`(authorize) | 자동 검사 |
| 스위치 라우트: 권한·CSRF·입력·쓰기 토큰이 없으면 GitHub 호출 0회 | 코드·CI | 테스트: `src/lib/orch/github.test.ts` › "route POST scope all: read session, missing/wrong CSRF, no auth, bad input, no write token → zero GitHub calls" | 자동 검사 |
| 관리자 비밀번호 해시 scrypt(고정 비용·솔트), 평문·형식 오류·약한 설정 거부 | 코드·CI | 테스트: `src/lib/session/password.test.ts` › "password hash is fixed-cost salted scrypt; plaintext/malformed/weak costs fail closed" | 자동 검사 |
| 보호 경로(.github/·scripts/orch/) 수정 시 푸시 중단 | 코드·CI | 판별 테스트(경로 판별 C.touchesProtected): `scripts/orch/core.test.mjs` › "PR marker and protected paths" / 푸시 중단 코드: `scripts/orch/main.mjs`(commitAndPush가 touchesProtected 결과가 있으면 '보호 경로를 수정해 푸시하지 않았습니다'로 멈춤) | 자동 검사 |
| main 브랜치 보호 (필수 검사 포함) | 운영 설정 | GitHub 저장소 Settings → Branches(또는 Rules) | 사람 확인 |
| BOT_PAT 권한 범위 | 운영 설정 | [매뉴얼 8장](ORCH_MANUAL.md#8-처음-한-번-설정-저장소마다) 표 · 저장소 Settings → Secrets and variables → Actions | 사람 확인 |
| ORCH_GITHUB_TOKEN 권한 범위 | 운영 설정 | [매뉴얼 10장](ORCH_MANUAL.md#10-모바일-상황판-ai-orchestrator-앱) 토큰 권한 표 · Vercel 프로젝트 Settings → Environment Variables | 사람 확인 |
| Vercel 환경변수 (관리자 비밀값) | 운영 설정 | Vercel 프로젝트 Settings → Environment Variables · [관리자 로그인](ADMIN_LOGIN.md) | 사람 확인 |
| CODEX_AUTH_KEY | 운영 설정 | 저장소 Settings → Secrets and variables → Actions · 매뉴얼 10장 사용량 절 | 사람 확인 |
