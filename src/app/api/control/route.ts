import { NextResponse } from "next/server";
import { getRunStore, RunStoreConfigurationError } from "@/lib/runs/store";
import { checkAdmin } from "@/lib/control/auth";
import { mutateControl, requestCancel, type Mutation } from "@/lib/control/service";

export const dynamic = "force-dynamic";
const H = { "Cache-Control": "no-store" };

export async function POST(req: Request): Promise<NextResponse> {
  const auth = checkAdmin(req.headers.get("x-admin-token"));
  if (!auth.ok) return NextResponse.json({ error: auth.status === 503 ? "control_unconfigured" : "unauthorized" }, { status: auth.status, headers: H });
  const raw = await req.text();
  if (raw.length > 16 * 1024) return NextResponse.json({ error: "too_large" }, { status: 413, headers: H });
  let b: Record<string, unknown>;
  try { b = JSON.parse(raw); } catch { return NextResponse.json({ error: "bad_request" }, { status: 400, headers: H }); }
  if (!b || typeof b !== "object") return NextResponse.json({ error: "bad_request" }, { status: 400, headers: H });
  const now = new Date().toISOString();
  try {
    const store = getRunStore();
    if (b.action === "cancel") {
      const r = await requestCancel(store, String(b.dispatchId ?? ""), "dashboard", now);
      return NextResponse.json({ cancelled: false, ...r }, { status: 409, headers: H }); // never claims cancellation
    }
    const expected = typeof b.expectedVersion === "number" ? b.expectedVersion : undefined;
    const r = await mutateControl(store, b as unknown as Mutation, "dashboard", now, expected);
    if (!r.ok) return NextResponse.json({ error: r.reason, detail: r.detail }, { status: r.reason === "version_conflict" ? 409 : 400, headers: H });
    return NextResponse.json({ ok: true, control: r.control }, { headers: H });
  } catch (e) {
    const cfg = e instanceof RunStoreConfigurationError;
    return NextResponse.json({ error: cfg ? "store_unconfigured" : "store_error" }, { status: cfg ? 503 : 500, headers: H });
  }
}
