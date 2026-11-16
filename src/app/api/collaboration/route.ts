import { demoRequestBlock, demoReadResponse } from "@/lib/demo/respond-http";
import { requireRead } from "../_auth";
import { handleCollaboration } from "@/lib/runs/collaboration-http";
import { dependencies } from "./dependencies";
export const dynamic = "force-dynamic";
async function handle(req: Request) {
  const blocked = demoRequestBlock(req);
  if (blocked) return blocked;
  if (req.method === "GET") {
    const denied = requireRead(req);
    if (denied) return denied;
    const demo = demoReadResponse(req, "collaboration");
    if (demo) return demo;
  }
  const r = await handleCollaboration(req.method, req.headers, req.method === "GET" ? "" : await req.text(), dependencies());
  return new Response(r.body, { status: r.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
export const GET = handle;
export const POST = handle;
