// Phase 5 — real dispatch adapter for the one mechanism that actually exists in this repo's setup:
// GitHub issue labels (agent:<x> + status:ready) which external scheduled routines watch.
// GPT has NO supported dispatch mechanism here (PM role is manual in ChatGPT) -> never submitted.
import type { DispatchRecord } from "./run-tracking";
import type { RunStore } from "./store";
import { authorizeSubmission, recordSubmission, requestDispatch, type SubmitOutcome } from "./service";
import type { Capability } from "../control/model";

export interface SubmitResult { outcome: SubmitOutcome; error?: string }
export interface DispatchAdapter {
  supports(agent: string): boolean;
  /** `idempotencyKey` = dispatchId. Must NOT throw; transport failure => "unknown". */
  submit(rec: DispatchRecord, idempotencyKey: string): Promise<SubmitResult>;
}

// Opus has its own routine namespace (agent:opus); Sonnet stays agent:claude.
const LABEL_OF: Record<string, string> = { "claude-sonnet": "agent:claude", "claude-opus": "agent:opus", codex: "agent:codex" };
export const READY_LABEL = "status:ready";
const REPLACED_NAMESPACES = ["agent:", "status:"];

const labelNames = (labels: unknown): string[] | undefined => {
  if (!Array.isArray(labels)) return undefined;
  const names = labels.map((l) => (typeof l === "string" ? l : l && typeof l === "object" ? (l as { name?: unknown }).name : undefined));
  return names.every((n): n is string => typeof n === "string") ? names : undefined;
};

/** Pure: drop every prior agent:/status: label, keep unrelated labels (order, dedup), append target agent + status:ready. */
export function replaceHandoffLabels(current: readonly string[], agentLabel: string): string[] {
  const kept = [...new Set(current.filter((n) => !REPLACED_NAMESPACES.some((p) => n.startsWith(p))))];
  return [...kept, agentLabel, READY_LABEL];
}

/** True iff `names` has exactly one agent:* (== agentLabel) and exactly one status:* (== status:ready). */
export function hasExactHandoff(names: readonly string[], agentLabel: string): boolean {
  const agents = names.filter((n) => n.startsWith("agent:"));
  const statuses = names.filter((n) => n.startsWith("status:"));
  return agents.length === 1 && agents[0] === agentLabel && statuses.length === 1 && statuses[0] === READY_LABEL;
}

/**
 * Hands an issue to one agent by REPLACING its agent:/status: namespaces (GitHub "set labels", PUT).
 * Sequence: GET issue (read current labels) -> PUT full label set -> verify the PUT response.
 * Not atomic: GitHub offers no compare-and-set on labels, and X-Idempotency-Key is only a trace hint
 * (GitHub ignores it). A label write by another actor between GET and PUT can be overwritten. Exclusivity
 * relies on the store gate (authorizeSubmission / one active dispatch per issue), not on GitHub.
 * Outcomes: read failure or 4xx write => nothing written => rejected_not_accepted;
 * 5xx/408/transport/timeout on write, or an unverifiable/mismatching 2xx response => unknown (never auto-retried).
 * "accepted" only means GitHub accepted the label set; it is NOT evidence that any agent executed.
 */
export class GitHubLabelAdapter implements DispatchAdapter {
  constructor(private cfg: { token: string; repo: string; timeoutMs?: number }, private request: typeof fetch = fetch) {}
  supports(agent: string) { return agent in LABEL_OF; }
  private init(method: string, key: string, body?: unknown): RequestInit {
    return {
      method, cache: "no-store", signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 10_000),
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${this.cfg.token}`, "X-GitHub-Api-Version": "2022-11-28", "X-Idempotency-Key": key, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
  }
  async submit(rec: DispatchRecord, key: string): Promise<SubmitResult> {
    if (!this.cfg.token.trim()) return { outcome: "rejected_not_accepted", error: "github token not configured" };
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(this.cfg.repo)) return { outcome: "rejected_not_accepted", error: "invalid repo config" };
    if (!Number.isSafeInteger(rec.issueNumber) || rec.issueNumber <= 0) return { outcome: "rejected_not_accepted", error: "invalid issue number" };
    const agentLabel = LABEL_OF[rec.agent];
    if (!agentLabel) return { outcome: "rejected_not_accepted", error: "unsupported agent" };
    const issueUrl = `https://api.github.com/repos/${this.cfg.repo}/issues/${rec.issueNumber}`;

    // 1) Read. Nothing has been written yet, so every failure here is a definite non-acceptance.
    let current: string[];
    try {
      const res = await this.request(issueUrl, this.init("GET", key));
      if (!res.ok) return { outcome: "rejected_not_accepted", error: `read http ${res.status}` };
      const issue = (await res.json()) as { state?: unknown; pull_request?: unknown; labels?: unknown };
      if (issue.pull_request) return { outcome: "rejected_not_accepted", error: "target is a pull request" };
      if (issue.state !== "open") return { outcome: "rejected_not_accepted", error: "issue not open" };
      const names = labelNames(issue.labels);
      if (!names) return { outcome: "rejected_not_accepted", error: "unreadable labels" };
      current = names;
    } catch {
      return { outcome: "rejected_not_accepted", error: "read transport error or timeout (no write attempted)" };
    }

    // 2) Replace the full label set.
    const desired = replaceHandoffLabels(current, agentLabel);
    let res: Response;
    try {
      res = await this.request(`${issueUrl}/labels`, this.init("PUT", key, { labels: desired }));
    } catch {
      return { outcome: "unknown", error: "transport error or timeout (ack may be lost)" }; // never leak token/err detail
    }
    if (res.status >= 500 || res.status === 408) return { outcome: "unknown", error: `http ${res.status}` };
    if (!res.ok) return { outcome: "rejected_not_accepted", error: `http ${res.status}` }; // 4xx: definitively not applied

    // 3) Verify the label set GitHub reports after the write.
    let after: string[] | undefined;
    try { after = labelNames(await res.json()); } catch { after = undefined; }
    if (!after) return { outcome: "unknown", error: "unverifiable label response" };
    if (!hasExactHandoff(after, agentLabel)) return { outcome: "unknown", error: "label set mismatch after write" };
    const missing = desired.filter((n) => !after!.includes(n));
    if (missing.length) return { outcome: "unknown", error: "unrelated labels not preserved" };
    return { outcome: "accepted" };
  }
}

export type DispatchResult =
  | { ok: true; record: DispatchRecord }
  | { ok: false; stage: "request" | "gate" | "adapter"; reason: string };

/** request (gated) -> authorizeSubmission (gated, atomic, IMMEDIATELY before provider) -> adapter -> durable outcome. */
export async function dispatchIssue(store: RunStore, adapter: DispatchAdapter, issueNumber: number, agent: string, now: string, capability?: Capability): Promise<DispatchResult> {
  if (!adapter.supports(agent)) return { ok: false, stage: "adapter", reason: "unsupported_agent" };
  const req = await requestDispatch(store, issueNumber, agent, now, capability);
  if (!req.ok) return { ok: false, stage: "request", reason: req.reason };
  return submitQueued(store, adapter, req.record.dispatchId, now);
}

/** Also used to release held records and by reconciliation. */
export async function submitQueued(store: RunStore, adapter: DispatchAdapter, dispatchId: string, now: string): Promise<DispatchResult> {
  const auth = await authorizeSubmission(store, dispatchId, now);
  if (!auth.ok) return { ok: false, stage: "gate", reason: auth.reason };
  if (!adapter.supports(auth.record.agent)) {
    await recordSubmission(store, dispatchId, "rejected_not_accepted", now, "unsupported agent");
    return { ok: false, stage: "adapter", reason: "unsupported_agent" };
  }
  const r = await adapter.submit(auth.record, dispatchId);
  const rec = await recordSubmission(store, dispatchId, r.outcome, now, r.error);
  return r.outcome === "rejected_not_accepted" ? { ok: false, stage: "adapter", reason: r.error ?? "rejected" } : { ok: true, record: rec! };
}
