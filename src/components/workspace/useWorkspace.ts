"use client";
import { useAuthedJson } from "@/components/live/useAuthedJson";
import { useGitHubEvidence } from "@/components/github/GitHubEvidencePanels";
import { workspace, workActivity, type Runtime } from "@/lib/github/mobile-workspace";
import type { WorkQueueTask } from "@/lib/github/work-queue";
export function useWorkspace() {
  const queue = useAuthedJson<WorkQueueTask[]>("/api/work-queue", (status, body) => {
    const j = body as { mode?: string; tasks?: WorkQueueTask[] } | null;
    return j?.mode === "unconfigured" ? "unconfigured" : status === 200 && j?.mode === "live" && Array.isArray(j.tasks) ? j.tasks : null;
  });
  const evidence = useGitHubEvidence();
  const runtime = useAuthedJson<Runtime>("/api/dashboard", (status, body) => {
    const j = body as Runtime & { mode?: string } | null;
    return j?.mode === "unconfigured" ? "unconfigured" : status === 200 && j?.mode === "live" && Array.isArray(j.agents) && Array.isArray(j.runs) && Array.isArray(j.audit) ? j : null;
  });
  const report = evidence.state.kind === "ok" ? evidence.state.data : undefined;
  const snapshot = runtime.state.kind === "ok" ? runtime.state.data : undefined;
  const model = workspace(queue.state.kind === "ok" ? queue.state.data : [], report);
  return { ...model, queue, evidence, runtime, snapshot, report, events: workActivity(model.tasks, report, snapshot) };
}
