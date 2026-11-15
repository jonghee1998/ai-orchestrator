// 전역 새로고침 센터 (#81) — React 와 분리된 순수 로직. 읽기(GET) 재검증만 조정하며 어떤 변경 요청도 보내지 않는다.
// - 동시 클릭은 진행 중인 하나의 새로고침으로 합친다 (dedupe).
// - 성공한 로더가 하나라도 있을 때만 마지막 성공 시각을 갱신한다. 실패는 목록으로 노출하고 기존 데이터는 각 로더가 유지한다.

/** 로더는 성공하면 true, 실패(오류/비정상 응답)면 false 를 반환한다. 절대 throw 하지 않아야 하지만 방어적으로 처리한다. */
export type Loader = () => Promise<boolean>;
export type RefreshSnapshot = { inFlight: boolean; lastSuccessAt: number | null; failed: string[]; registered: number };

export function createRefreshCenter(now: () => number = Date.now) {
  const loaders = new Map<symbol, { id: string; run: Loader }>();
  const subs = new Set<() => void>();
  let snap: RefreshSnapshot = { inFlight: false, lastSuccessAt: null, failed: [], registered: 0 };
  let inflight: Promise<RefreshSnapshot> | null = null;
  const set = (p: Partial<RefreshSnapshot>) => { snap = { ...snap, ...p }; subs.forEach((f) => f()); };

  return {
    register(id: string, run: Loader) {
      const key = Symbol(id);
      loaders.set(key, { id, run });
      set({ registered: loaders.size });
      return () => { loaders.delete(key); set({ registered: loaders.size }); };
    },
    /** 모든 등록 로더를 즉시 재실행. 이미 진행 중이면 같은 Promise 를 돌려준다. */
    refreshAll(): Promise<RefreshSnapshot> {
      if (inflight) return inflight;
      const entries = [...loaders.values()];
      set({ inFlight: true });
      inflight = (async () => {
        const results = await Promise.all(entries.map(async (e) => ({ id: e.id, ok: await e.run().catch(() => false) })));
        const failed = results.filter((r) => !r.ok).map((r) => r.id);
        const anyOk = results.some((r) => r.ok);
        set({ inFlight: false, failed, lastSuccessAt: anyOk ? now() : snap.lastSuccessAt });
        inflight = null;
        return snap;
      })();
      return inflight;
    },
    getSnapshot: () => snap,
    subscribe(cb: () => void) { subs.add(cb); return () => { subs.delete(cb); }; },
  };
}

export type SharedResponse = { status: number; body: unknown };
type FetchLike = (input: string, init: { cache: "no-store"; headers: Record<string, string> }) => Promise<{ status: number; json: () => Promise<unknown> }>;

/** 같은 경로·토큰의 동시 GET 을 하나로 합친다. 완료 후에는 캐시하지 않으므로 매 호출이 신선한 재검증이다. */
export function createSharedGet(fetchFn: FetchLike) {
  const pending = new Map<string, Promise<SharedResponse>>();
  return function sharedGet(path: string, token: string): Promise<SharedResponse> {
    const k = `${path}\u0000${token}`;
    const hit = pending.get(k);
    if (hit) return hit;
    const p = (async () => {
      const r = await fetchFn(path, { cache: "no-store", headers: { "x-admin-token": token } });
      const body = await r.json().catch(() => null);
      return { status: r.status, body };
    })().finally(() => { pending.delete(k); });
    pending.set(k, p);
    return p;
  };
}
