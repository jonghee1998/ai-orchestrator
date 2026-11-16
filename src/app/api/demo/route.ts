import { handleDemoState } from "@/lib/demo/state-http";
export const dynamic = "force-dynamic";
async function handle(req: Request) {
  const r = handleDemoState(req.method, req.headers, req.method === "POST" ? await req.text() : "", process.env);
  const headers = new Headers({ "Cache-Control": "no-store", "Content-Type": "application/json" });
  if (r.setCookie) headers.append("Set-Cookie", r.setCookie);
  return new Response(JSON.stringify(r.body), { status: r.status, headers });
}
export const GET = handle;
export const POST = handle;
