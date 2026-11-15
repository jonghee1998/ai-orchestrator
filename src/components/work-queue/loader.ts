// 작업 큐 로딩 로직 — React 와 분리하여 단위 테스트 가능하게 둔다.
import { parseResponse, type WorkQueueResponse } from "./viewModel";

export type Source =
  | { kind: "loading" }
  | { kind: "live"; res: WorkQueueResponse }
  | { kind: "notoken" }
  | { kind: "unauth" }
  | { kind: "unavailable"; reason: string }
  | { kind: "sample" };

type FetchLike = (
  input: string,
  init?: { cache?: "no-store"; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** GET /api/work-queue 를 호출해 화면 상태로 변환한다. 절대 throw 하지 않는다.
 *  #65: 보호된 읽기 API이므로 홈과 같은 탭 토큰(x-admin-token)을 반드시 보낸다. 토큰 없음/401 은 명시 상태. */
export async function loadQueue(fetchFn: FetchLike, token: string): Promise<Source> {
  const t = token.trim();
  if (!t) return { kind: "notoken" };
  try {
    const r = await fetchFn("/api/work-queue", { cache: "no-store", headers: { "x-admin-token": t } });
    if (r.status === 401) return { kind: "unauth" };
    // 502 등 오류 응답도 계약(mode:"error")을 따르므로 본문을 먼저 해석한다.
    const body: unknown = await r.json().catch(() => null);
    const res = parseResponse(body);
    if (!res)
      return {
        kind: "unavailable",
        reason: r.ok ? "응답 형식이 계약과 다릅니다" : `HTTP ${r.status}`,
      };
    return { kind: "live", res };
  } catch (e) {
    return {
      kind: "unavailable",
      reason: e instanceof Error ? e.message : "알 수 없는 오류",
    };
  }
}

/** 최신 요청만 반영하기 위한 추적기. 오래된 응답은 무시된다. */
export function createRequestTracker() {
  let current = 0;
  return {
    next: () => ++current,
    /** 진행 중인 모든 요청을 무효화한다 (샘플 전환·언마운트). */
    invalidate: () => void ++current,
    isCurrent: (id: number) => id === current,
  };
}
