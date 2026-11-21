// 프로젝트 탭 새로고침 성공 판정. reload() 반환값은 다른 요청에 밀리면 false 일 수 있어 쓰지 않는다.
// reload 가 끝난 뒤의 error·state 만 본다: error 가 있거나 state.kind 가 'ok' 가 아니면 실패.
export function refreshSucceeded(latest: { state: { kind: string }; error: unknown }): boolean {
  return !latest.error && latest.state.kind === "ok";
}
