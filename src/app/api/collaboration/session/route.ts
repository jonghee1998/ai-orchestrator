import { handleSession } from "@/lib/runs/session-http";
import { dependencies } from "../dependencies";
export const dynamic = "force-dynamic";
/** #55 routine-session channel (proxy-injected per-agent header). See src/lib/runs/session-auth.ts and docs/SESSION_AUTH.md. */
export async function POST(req: Request) {
  const r = await handleSession(req.headers, await req.text(), dependencies());
  return new Response(r.body, { status: r.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
export function GET() {
  return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", Allow: "POST" } });
}
