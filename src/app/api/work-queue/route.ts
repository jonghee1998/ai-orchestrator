import { NextResponse } from "next/server";
import { demoReadResponse } from "@/lib/demo/respond-http";
import { requireRead } from "../_auth";
import {
  GitHubQueueConfigurationError,
  readGitHubWorkQueue,
} from "@/lib/github/github-read-queue";
import type { WorkQueueTask } from "@/lib/github/work-queue";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type WorkQueueResponse = {
  mode: "live" | "unconfigured" | "error";
  tasks: WorkQueueTask[];
  error?: string;
};

export async function GET(req: Request): Promise<NextResponse<WorkQueueResponse> | NextResponse> {
  const denied = requireRead(req);
  if (denied) return denied;
  const demo = demoReadResponse(req, "work-queue");
  if (demo) return demo as NextResponse;
  try {
    const tasks = await readGitHubWorkQueue();
    return NextResponse.json({ mode: "live", tasks }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const unconfigured = error instanceof GitHubQueueConfigurationError;
    return NextResponse.json(
      {
        mode: unconfigured ? "unconfigured" : "error",
        tasks: [],
        error: unconfigured ? "GitHub work queue is not configured" : "Unable to read GitHub work queue",
      },
      { status: unconfigured ? 200 : 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
