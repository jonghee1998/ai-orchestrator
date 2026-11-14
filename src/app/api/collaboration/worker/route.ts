import { handleCollaborationWorker } from "@/lib/runs/collaboration-http";
import { dependencies } from "../dependencies";
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  const r = await handleCollaborationWorker(req.headers, await req.text(), dependencies());
  return new Response(r.body, { status: r.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...(r.signature ? { "x-signature": r.signature } : {}) } });
}
