"use client";
// #34 — shared authenticated loader for live pages. Uses the same per-tab token as the home dashboard.
// Never invents data: no token / 401 / unconfigured / error are explicit states.
import { useCallback, useEffect, useRef, useState } from "react";
import { sharedGet, useRegisterRefresh } from "./refresh";

export type Live<T> =
  | { kind: "loading" } | { kind: "notoken" } | { kind: "unauth" } | { kind: "unconfigured" }
  | { kind: "error"; detail: string } | { kind: "ok"; data: T };

/** Same per-tab token the home dashboard stores. Exported so every live loader (incl. /tasks) uses one source. */
export const readToken = () => { try { return sessionStorage.getItem("ctl-token") ?? ""; } catch { return ""; } };
/** Header set for authenticated read endpoints. */
export const authHeaders = (token: string) => ({ "x-admin-token": token });

/** `accept` returns the data if the body is the live contract, "unconfigured" if the server says so, else null (=error).
 *  #81: 오류·네트워크 실패 시 마지막 정상 데이터를 유지하고(`error` 로 실패를 별도 노출), 401/토큰 없음만 상태를 교체한다.
 *  모든 인스턴스는 전역 새로고침에 등록되며, 같은 경로의 동시 GET 은 sharedGet 이 합친다. 폴링 주기는 그대로다. */
export function useAuthedJson<T>(path: string, accept: (status: number, body: unknown) => T | "unconfigured" | null, intervalMs = 15000) {
  const [s, setS] = useState<Live<T>>({ kind: "loading" });
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const good = useRef(false); // 정상 데이터를 한 번이라도 보유했는가
  const acceptRef = useRef(accept); acceptRef.current = accept;
  const fail = (my: number, next: Live<T>, detail: string) => {
    if (my !== seq.current) return false;
    if (good.current) setError(detail); else setS(next);
    return false;
  };
  /** 성공 여부를 반환한다 (전역 새로고침이 부분 실패를 집계). */
  const load = useCallback(async (): Promise<boolean> => {
    const my = ++seq.current;
    const token = readToken().trim();
    if (!token) { good.current = false; setError(null); setS({ kind: "notoken" }); return false; }
    try {
      const r = await sharedGet(path, token);
      if (my !== seq.current) return false;
      if (r.status === 401) { good.current = false; setError(null); setS({ kind: "unauth" }); return false; }
      if (r.status === 503) return fail(my, { kind: "unconfigured" }, "서버 설정 없음 (unconfigured)");
      const v = acceptRef.current(r.status, r.body);
      if (v === "unconfigured") return fail(my, { kind: "unconfigured" }, "서버 설정 없음 (unconfigured)");
      if (v === null) return fail(my, { kind: "error", detail: `HTTP ${r.status}` }, `HTTP ${r.status}`);
      good.current = true; setError(null); setS({ kind: "ok", data: v });
      return true;
    } catch { return fail(my, { kind: "error", detail: "네트워크 오류" }, "네트워크 오류"); }
  }, [path]);
  useEffect(() => { load(); const id = setInterval(load, intervalMs); return () => { clearInterval(id); seq.current++; }; }, [load, intervalMs]);
  useRegisterRefresh(path, load);
  return { state: s, reload: load, error };
}
