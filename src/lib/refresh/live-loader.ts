// 공용 라이브 로더 코어 (#83) — React 와 분리된 순수 로직. useAuthedJson 이 이 모듈을 감싼다.
// - 오류·네트워크 실패 시 마지막 정상 데이터를 유지하고 `error` 로 실패를 별도 노출한다 (자동 폴링 포함, 같은 경로).
// - 401/토큰 없음만 상태를 교체한다. 오래된 응답(stale race)은 seq 로 폐기한다.
import type { SharedResponse } from "./center";

export type Live<T> =
  | { kind: "loading" } | { kind: "notoken" } | { kind: "unauth" } | { kind: "unconfigured" }
  | { kind: "error"; detail: string } | { kind: "ok"; data: T };
export type LiveView<T> = { state: Live<T>; error: string | null };
export type Accept<T> = (status: number, body: unknown) => T | "unconfigured" | null;

export function createLiveLoader<T>(opts: {
  path: string;
  accept: () => Accept<T>;
  getToken: () => string;
  get: (path: string, token: string) => Promise<SharedResponse>;
  onChange: (v: LiveView<T>) => void;
}) {
  let seq = 0;
  let good = false;
  let view: LiveView<T> = { state: { kind: "loading" }, error: null };
  const emit = (v: LiveView<T>) => { view = v; opts.onChange(v); };
  const fail = (my: number, next: Live<T>, detail: string) => {
    if (my !== seq) return false;
    if (good) emit({ state: view.state, error: detail }); else emit({ state: next, error: null });
    return false;
  };
  return {
    getView: () => view,
    /** 이후 도착하는 응답을 모두 폐기한다 (언마운트). */
    dispose() { seq++; },
    /** 성공 여부를 반환한다 (전역 새로고침이 부분 실패를 집계). */
    async load(): Promise<boolean> {
      const my = ++seq;
      const token = opts.getToken().trim();
      if (!token) { good = false; emit({ state: { kind: "notoken" }, error: null }); return false; }
      try {
        const r = await opts.get(opts.path, token);
        if (my !== seq) return false;
        if (r.status === 401) { good = false; emit({ state: { kind: "unauth" }, error: null }); return false; }
        if (r.status === 503) return fail(my, { kind: "unconfigured" }, "서버 설정 없음 (unconfigured)");
        const v = opts.accept()(r.status, r.body);
        if (v === "unconfigured") return fail(my, { kind: "unconfigured" }, "서버 설정 없음 (unconfigured)");
        if (v === null) return fail(my, { kind: "error", detail: `HTTP ${r.status}` }, `HTTP ${r.status}`);
        good = true; emit({ state: { kind: "ok", data: v }, error: null });
        return true;
      } catch { return fail(my, { kind: "error", detail: "네트워크 오류" }, "네트워크 오류"); }
    },
  };
}
