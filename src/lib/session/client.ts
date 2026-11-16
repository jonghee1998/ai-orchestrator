// 클라이언트 측 세션 표식 (#85). 로더는 "토큰 문자열"을 받는 기존 계약을 유지하되, 세션 로그인 상태에서는 원본 토큰 대신
// 이 표식을 넘긴다. 표식일 때는 x-admin-token 헤더를 보내지 않고 HttpOnly 쿠키(same-origin)에 의존한다. 표식은 비밀이 아니다.
export const SESSION_MARK = "\u0000session";
export const tokenHeaders = (token: string): Record<string, string> => (token === SESSION_MARK ? {} : { "x-admin-token": token });
