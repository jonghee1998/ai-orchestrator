"use client";
import { GitHubTaskSplitPanel, useGitHubEvidence } from "./GitHubEvidencePanels";
export function TasksEvidence() {
  const ev = useGitHubEvidence();
  return <GitHubTaskSplitPanel ev={ev} />;
}
