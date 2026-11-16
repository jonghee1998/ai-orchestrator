"use client";
// #34 — shared authenticated loader for live pages. Uses the same per-tab token as the home dashboard.
// Never invents data: no token / 401 / unconfigured / error are explicit states.
import { useEffect, useRef, useState } from "react";
import { createLiveLoader, type Accept, type Live, type LiveView } from "@/lib/refresh/live-loader";
import { sharedGet, useRegisterRefresh } from "./refresh";

export type { Live } from "@/lib/refresh/live-loader";

/** Same per-tab token the home dashboard stores. Exported so every live loader (incl. /tasks) uses one source. */
import { readToken, useSession } from "./session";
export { readToken };

/** `accept` returns the data if the body is the live contract, "unconfigured" if the server says so, else null (=error).
 *  #81: 오류·네트워크 실패 시 마지막 정상 데이터를 유지하고(`error` 로 실패를 별도 노출), 401/토큰 없음만 상태를 교체한다.
 *  모든 인스턴스는 전역 새로고침에 등록되며, 같은 경로의 동시 GET 은 sharedGet 이 합친다. 폴링 주기는 그대로다. */
export function useAuthedJson<T>(path: string, accept: Accept<T>, intervalMs = 15000) {
  const sess = useSession().version; // 로그인/로그아웃/만료 시 재조회
  const [view, setView] = useState<LiveView<T>>({ state: { kind: "loading" }, error: null });
  const acceptRef = useRef(accept); acceptRef.current = accept;
  const loader = useRef<ReturnType<typeof createLiveLoader<T>> | null>(null);
  const load = useRef(() => (loader.current ? loader.current.load() : Promise.resolve(false))).current;
  useEffect(() => {
    const l = createLiveLoader<T>({ path, accept: () => acceptRef.current, getToken: readToken, get: sharedGet, onChange: setView });
    loader.current = l;
    void l.load();
    const id = setInterval(() => { void l.load(); }, intervalMs);
    return () => { clearInterval(id); l.dispose(); loader.current = null; };
  }, [path, intervalMs, sess]);
  useRegisterRefresh(path, load);
  return { state: view.state as Live<T>, reload: load, error: view.error };
}
