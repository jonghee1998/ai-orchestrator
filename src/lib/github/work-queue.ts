export const QUEUE_AGENTS = ["claude", "opus", "codex"] as const;
export type QueueAgent = (typeof QUEUE_AGENTS)[number] | "unknown";

export const QUEUE_STATUSES = [
  "backlog",
  "ready",
  "queued",
  "in-progress",
  "review",
  "done",
  "blocked",
] as const;

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state?: string;
  labels: Array<string | { name?: string | null }>;
  pull_request?: unknown;
  milestone?: { number: number; title: string; description?: string | null } | null;
}

export interface WorkQueueTask {
  project?: { id: string; name: string; goal?: string };
  issueState?: "open" | "closed";
  description?: string;
  id: string;
  title: string;
  agent: QueueAgent;
  status: string;
  dependsOn: string[];
  url: string;
}

export interface DispatchPlan {
  task: WorkQueueTask;
  eligible: boolean;
  reasons: string[];
  /** Stable hint for a future dispatcher; it is not a lock or reservation. */
  idempotencyKey: string;
}

const dependencyLine = /^\s*depends\s+on\s*:\s*(.*?)\s*$/gim;

function labelNames(issue: GitHubIssue): string[] {
  return issue.labels
    .map((label) => (typeof label === "string" ? label : label.name))
    .filter((label): label is string => typeof label === "string");
}

function oneNamespacedLabel(
  labels: string[],
  prefix: string,
  allowed: readonly string[],
): string | undefined {
  const matching = labels.filter((label) => label.startsWith(prefix));
  if (matching.length !== 1) return undefined;
  const value = matching[0].slice(prefix.length);
  return allowed.includes(value) ? value : undefined;
}

export function parseDependencies(body: string | null): string[] {
  if (!body) return [];
  const dependencies = new Set<number>();
  for (const match of body.matchAll(dependencyLine)) {
    for (const reference of match[1].matchAll(/#(\d+)/g)) {
      const issueNumber = Number(reference[1]);
      if (Number.isSafeInteger(issueNumber) && issueNumber > 0) {
        dependencies.add(issueNumber);
      }
    }
  }
  return [...dependencies].sort((left, right) => left - right).map(String);
}

export function normalizeIssues(issues: GitHubIssue[]): WorkQueueTask[] {
  const unique = new Map<number, GitHubIssue>();
  for (const issue of issues) {
    if (!issue.pull_request && !unique.has(issue.number)) unique.set(issue.number, issue);
  }

  return [...unique.values()]
    .sort((left, right) => left.number - right.number)
    .map((issue) => {
      const labels = labelNames(issue);
      const agent = oneNamespacedLabel(labels, "agent:", QUEUE_AGENTS);
      // A closed issue is completed work regardless of a stale status label.
      const status =
        issue.state === "closed"
          ? "done"
          : oneNamespacedLabel(labels, "status:", QUEUE_STATUSES);
      const projects = labels.filter((x) => x.startsWith("project:") && x.slice(8).trim());
      const project = projects.length === 1 ? { id: `label:${projects[0].slice(8)}`, name: projects[0].slice(8) }
        : projects.length === 0 && issue.milestone ? { id: `milestone:${issue.milestone.number}`, name: issue.milestone.title, goal: issue.milestone.description ?? undefined } : undefined;
      return {
        ...(project ? { project } : {}),
        ...(issue.state === "open" || issue.state === "closed" ? { issueState: issue.state } : {}),
        ...(issue.body ? { description: issue.body } : {}),
        id: String(issue.number),
        title: issue.title,
        agent: (agent ?? "unknown") as QueueAgent,
        status: status ?? "unknown",
        dependsOn: parseDependencies(issue.body),
        url: issue.html_url,
      };
    });
}

function tasksInCycles(tasks: WorkQueueTask[]): Set<string> {
  const taskIds = new Set(tasks.map((task) => task.id));
  const edges = new Map(tasks.map((task) => [task.id, task.dependsOn.filter((id) => taskIds.has(id))]));
  const cyclic = new Set<string>();
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  function visit(id: string): void {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      for (const member of stack.slice(start)) cyclic.add(member);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    stack.push(id);
    for (const dependency of edges.get(id) ?? []) visit(dependency);
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  }

  for (const task of tasks) visit(task.id);
  return cyclic;
}

/**
 * Produces deterministic, read-only dispatch advice. Eligibility is fail-closed.
 * The returned key can support future idempotency, but does not provide atomic
 * claiming or distributed locking and must not be treated as one.
 */
export function planDispatch(tasks: WorkQueueTask[]): DispatchPlan[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const cyclic = tasksInCycles(tasks);
  return [...tasks]
    .sort((left, right) => Number(left.id) - Number(right.id) || left.id.localeCompare(right.id))
    .map((task) => {
      const reasons: string[] = [];
      if (task.agent === "unknown") reasons.push("unknown_or_multiple_agent_labels");
      if (task.status === "unknown") reasons.push("unknown_or_multiple_status_labels");
      else if (task.status !== "ready" && task.status !== "queued") reasons.push("not_queued");
      if (cyclic.has(task.id)) reasons.push("dependency_cycle");
      for (const id of task.dependsOn) {
        const dependency = byId.get(id);
        if (!dependency) reasons.push(`missing_dependency:${id}`);
        else if (dependency.status !== "done") reasons.push(`unmet_dependency:${id}`);
      }
      return {
        task,
        eligible: reasons.length === 0,
        reasons,
        idempotencyKey: `github-issue:${task.id}:agent:${task.agent}`,
      };
    });
}
