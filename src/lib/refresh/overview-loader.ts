// 개요 화면 로더 코어 (#83) — /api/dashboard 와 /api/readiness 를 독립적으로 추적한다.
// - readiness 실패는 대시보드 성공을 가리지 않는다: 마지막 정상 readiness 를 유지하고 readyError 로 부분 실패를 노출한다.
// - 대시보드 실패 시에도 마지막 정상 스냅샷을 유지한다. 401 만 상태를 교체한다.
import type { SharedResponse } from "./center";

export type OverviewView<S, R> = {
  state: { kind: "loading" } | { kind: "notoken" } | { kind: "unauth"; reason?: string } | { kind: "unconfigured" } | { kind: "error"; detail?: string } | { kind: "ok"; snap: S };
  ready: R | null;
  /** 대시보드 갱신 실패(마지막 정상 데이터 표시 중). */
  staleErr: string | null;
  /** readiness 갱신 실패(대시보드는 성공 가능). */
  readyError: string | null;
};
const initial = <S, R>(): OverviewView<S, R> => ({ state: { kind: "loading" }, ready: null, staleErr: null, readyError: null });

export function createOverviewLoader<S, R>(opts: {
  getToken: () => string;
  get: (path: string, token: string) => Promise<SharedResponse>;
  onChange: (v: OverviewView<S, R>) => void;
}) {
  let seq = 0;
  let good = false;
  let view = initial<S, R>();
  const emit = (v: OverviewView<S, R>) => { view = v; opts.onChange(v); };
  const settle = <T,>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), () => ({ ok: false as const }));
  return {
    getView: () => view,
    dispose() { seq++; },
    /** 대시보드와 readiness 가 모두 성공했을 때만 true (부분 실패는 false 로 집계된다). */
    async load(): Promise<boolean> {
      const my = ++seq;
      const token = opts.getToken().trim();
      if (!token) { good = false; emit({ ...initial<S, R>(), state: { kind: "notoken" } }); return false; }
      const [d, rd] = await Promise.all([settle(opts.get("/api/dashboard", token)), settle(opts.get("/api/readiness", token))]);
      if (my !== seq) return false;
      const keep = (next: OverviewView<S, R>["state"], detail: string) => {
        if (good) emit({ ...view, staleErr: detail, readyError: readinessError(rd) });
        else emit({ ...view, state: next, staleErr: null, readyError: readinessError(rd) });
        return false;
      };
      if (!d.ok) return keep({ kind: "error", detail: "네트워크 오류 (서버에 도달하지 못함)" }, "네트워크 오류 (서버에 도달하지 못함)");
      const r = d.v;
      const j = (r.body ?? {}) as Record<string, any>;
      if (r.status === 401) { good = false; emit({ state: { kind: "unauth", reason: j.reason }, ready: null, staleErr: null, readyError: null }); return false; }
      if (j.mode === "unconfigured" || r.status === 503) return keep({ kind: "unconfigured" }, "서버 설정 없음 (unconfigured)");
      if (!(r.status >= 200 && r.status < 300) || j.mode !== "live") {
        const detail = `HTTP ${r.status}${typeof j.category === "string" ? ` · 원인 분류: ${j.category}` : ""}`;
        return keep({ kind: "error", detail }, detail);
      }
      good = true;
      const readyOk = rd.ok && rd.v.status >= 200 && rd.v.status < 300 && rd.v.body != null && typeof rd.v.body === "object";
      emit({
        state: { kind: "ok", snap: j as S },
        ready: readyOk ? (rd as { ok: true; v: SharedResponse }).v.body as R : view.ready, // 실패 시 마지막 정상 readiness 유지
        staleErr: null,
        readyError: readyOk ? null : readinessError(rd),
      });
      return readyOk;
    },
  };
}
function readinessError(rd: { ok: true; v: SharedResponse } | { ok: false }): string | null {
  if (!rd.ok) return "네트워크 오류";
  const ok = rd.v.status >= 200 && rd.v.status < 300 && rd.v.body != null && typeof rd.v.body === "object";
  return ok ? null : `HTTP ${rd.v.status}`;
}
