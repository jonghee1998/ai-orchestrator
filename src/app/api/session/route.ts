import { handleSession } from "@/lib/session/http";
export const dynamic = "force-dynamic";
async function handle(req: Request) {
  const r = handleSession(req.method, req.headers, req.method === "POST" ? await req.text() : "", process.env, Date.now());
  const headers = new Headers({ "Cache-Control": "no-store", "Content-Type": "application/json" });
  if (r.setCookie) headers.append("Set-Cookie", r.setCookie);
  return new Response(JSON.stringify(r.body), { status: r.status, headers });
}
export const GET = handle;
export const POST = handle;
export const DELETE = handle;
