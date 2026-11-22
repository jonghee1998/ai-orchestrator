# 관리자 로그인

상황판은 관리자 1명이 아이디·비밀번호로 로그인합니다. 회원가입·이메일 인증·소셜 로그인은 없고 기본 계정도 없습니다.
설정이 없거나 해시가 잘못되면 로그인은 503으로 닫힙니다. 아이디·비밀번호·토큰·해시는 응답이나 브라우저 저장소에 남기지 않습니다.

## 최초 설정 (소유자가 직접)

1. 고유한 아이디와 긴 무작위 비밀번호(12바이트 이상)를 정해 비밀번호 관리자에 저장합니다.
2. 신뢰하는 로컬 터미널(셸 추적 `set -x` 끔)의 저장소 루트에서 해시를 만듭니다. `echo`는 줄바꿈을 붙이므로 쓰지 않습니다.

   ```bash
   read -r -s -p '새 관리자 비밀번호: ' admin_password
   printf '\n' >&2
   printf '%s' "$admin_password" | node scripts/hash-admin-password.mjs
   unset admin_password
   ```

3. 서버 비밀에 `ADMIN_USERNAME`과 출력된 `ADMIN_PASSWORD_HASH`를 넣습니다. **평문 비밀번호는 넣지 않습니다.**
   형식은 `scrypt$131072$8$1$<salt hex>$<키 hex>`로 고정이며 비교는 `timingSafeEqual`입니다. 해시도 공개·커밋하지 않습니다.
   로컬 `.env.local`(gitignore)에서는 해시 안의 **모든 `$`를 `\$`로** 바꿉니다(따옴표만으로는 부족). 호스팅 비밀 입력란에는 원본 그대로 넣습니다.
4. `CONTROL_ADMIN_TOKEN`(16자 이상 무작위 값)을 서버 비밀에만 둡니다. 세션 서명과 `/api/orch` 인증에 쓰이며 화면에 표시하거나 입력받지 않습니다.
   어떤 값도 `NEXT_PUBLIC_*`에 넣지 않습니다.
5. 서버를 재시작하고 로그인합니다.

## 세션·로그아웃

- 운영 쿠키: `__Host-orch_session; Path=/; HttpOnly; Secure; SameSite=Strict` (HTTPS 필수). HTTP 로컬 개발만 `orch_session`·Secure 생략.
- **로그인 상태 유지**를 고르면 30일 절대 만료, 안 고르면 브라우저 세션 쿠키(서버에서 12시간 후 만료).
- 쿠키에는 난수 세션 ID·역할·발급/만료 시각과 HMAC만 들어갑니다. 서명 키는 서버 토큰·아이디·해시·`CONTROL_SESSION_EPOCH`에 묶여
  이 값들이 바뀌면 기존 세션은 무효입니다. 쿠키 탈취가 의심되면 `CONTROL_SESSION_EPOCH`를 바꿔 전체 폐기합니다.
- 로그아웃은 CSRF 검증 후 쿠키를 지웁니다. 세션이 만료(401)되면 화면이 로그인 카드로 돌아갑니다.

## CSRF·로그인 시도 제한

- 로그인은 같은 출처 증거(Origin 또는 `Sec-Fetch-Site: same-origin`)가 필요합니다. 쿠키로 하는 변경 요청과 로그아웃은
  여기에 더해 세션별 `x-csrf-token`이 필요합니다. CSRF 값은 `GET /api/session`으로 받아 메모리에만 둡니다.
- 형식이 올바른 로그인 시도만 15분 창에서 셉니다: 클라이언트당 5회, 전체 50회, 성공하면 환불. 넘으면 429 + `Retry-After`.
- 클라이언트 구분은 Vercel(`VERCEL=1`) 또는 `LOGIN_TRUST_PROXY=vercel`일 때만 `x-vercel-forwarded-for`를 쓰고(IPv6는 /64 단위),
  그 밖에는 모두 한 버킷을 공유합니다. 카운터는 인스턴스별 메모리라 재시작하면 초기화됩니다.
- 스크립트는 `x-admin-token` 헤더(관리자/읽기 토큰)로 호출할 수 있습니다. 잘못된 헤더 토큰은 쿠키로 넘어가지 않습니다.

## 검증

`npm ci`, `npm run typecheck`, `npm test`, `npm run build` 후 `node --test scripts/login-smoke.test.mjs`
(임시 서버·테스트 전용 인증으로 실제 HTTP 동작 확인, 운영 서버·자격 증명은 쓰지 않음).
