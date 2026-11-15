"use client";
// #81 — 브라우저 싱글턴. 모든 라이브 로더가 여기에 등록되고, 상단 헤더 버튼이 refreshAll() 로 일괄 재검증한다.
import { useEffect, useRef, useSyncExternalStore } from "react";
import { createRefreshCenter, createSharedGet, type Loader } from "@/lib/refresh/center";

export const refreshCenter = createRefreshCenter();
export const sharedGet = createSharedGet((input, init) => fetch(input, init));

const server: ReturnType<typeof refreshCenter.getSnapshot> = { inFlight: false, lastSuccessAt: null, failed: [], registered: 0 };
export function useRefreshState() {
  return useSyncExternalStore(refreshCenter.subscribe, refreshCenter.getSnapshot, () => server);
}
/** 로더를 전역 새로고침에 등록한다 (항상 최신 클로저를 호출). */
export function useRegisterRefresh(id: string, loader: Loader) {
  const ref = useRef(loader); ref.current = loader;
  useEffect(() => refreshCenter.register(id, () => ref.current()), [id]);
}
