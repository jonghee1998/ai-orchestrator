import { checkCron } from "./auth";
import { authorize } from "../session/guard";
import type { Env } from "../session/session";
export interface ReconcileReply { status: number; body: unknown }
export async function handleReconcile(method: string, h: Headers, env: Env, now: number, run: () => Promise<ReconcileReply>): Promise<ReconcileReply> {
  if (method !== "GET" && method !== "POST") return { status: 405, body: { error: "method_not_allowed" } };
  // GET may only use an explicitly supplied machine credential. Never fall back to ambient cookies.
  const auth = method === "GET" ? checkCron(h.get("authorization"), h.get("x-admin-token"), env) : authorize(method, h, "admin", env, now);
  if (!auth.ok) return { status: auth.status, body: { error: auth.status === 503 ? "control_unconfigured" : "unauthorized" } };
  return run();
}
