"use client";
// #34 — shared authenticated loader for live pages. Uses the same per-tab token as the home dashboard.
// Never invents data: no token / 401 / unconfigured / error are explicit states.
import { useCallback, useEffect, useRef, useState } from "react";

export type Live<T> =
  | { kind: "loading" } | { kind: "notoken" } | { kind: "unauth" } | { kind: "unconfigured" }
  | { kind: "error"; detail: string } | { kind: "ok"; data: T };

/** Same per-tab token the home dashboard stores. Exported so every live loader (incl. /tasks) uses one source. */
export const readToken = () => { try { return sessionStorage.getItem("ctl-token") ?? ""; } catch { return ""; } };
/** Header set for authenticated read endpoints. */
export const authHeaders = (token: string) => ({ "x-admin-token": token });

/** `accept` returns the data if the body is the live contract, "unconfigured" if the server says so, else null (=error). */
export function useAuthedJson<T>(path: string, accept: (status: number, body: unknown) => T | "unconfigured" | null, intervalMs = 15000) {
  const [s, setS] = useState<Live<T>>({ kind: "loading" });
  const seq = useRef(0);
  const acceptRef = useRef(accept); acceptRef.current = accept;
  const load = useCallback(async () => {
    const my = ++seq.current;
    const token = readToken().trim();
    if (!token) { setS({ kind: "notoken" }); return; }
    try {
      const r = await fetch(path, { cache: "no-store", headers: authHeaders(token) });
      const body: unknown = await r.json().catch(() => null);
      if (my !== seq.current) return;
      if (r.status === 401) return setS({ kind: "unauth" });
      if (r.status === 503) return setS({ kind: "unconfigured" });
      const v = acceptRef.current(r.status, body);
      if (v === "unconfigured") return setS({ kind: "unconfigured" });
      if (v === null) return setS({ kind: "error", detail: `HTTP ${r.status}` });
      setS({ kind: "ok", data: v });
    } catch { if (my === seq.current) setS({ kind: "error", detail: "네트워크 오류" }); }
  }, [path]);
  useEffect(() => { load(); const id = setInterval(load, intervalMs); return () => { clearInterval(id); seq.current++; }; }, [load, intervalMs]);
  return { state: s, reload: load };
}
