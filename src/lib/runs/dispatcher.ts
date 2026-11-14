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

const LABEL_OF: Record<string, string> = { "claude-sonnet": "agent:claude", "claude-opus": "agent:claude", codex: "agent:codex" };

export class GitHubLabelAdapter implements DispatchAdapter {
  constructor(private cfg: { token: string; repo: string; timeoutMs?: number }, private request: typeof fetch = fetch) {}
  supports(agent: string) { return agent in LABEL_OF; }
  async submit(rec: DispatchRecord, key: string): Promise<SubmitResult> {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(this.cfg.repo)) return { outcome: "rejected_not_accepted", error: "invalid repo config" };
    const url = `https://api.github.com/repos/${this.cfg.repo}/issues/${rec.issueNumber}/labels`;
    try {
      const res = await this.request(url, {
        method: "POST", cache: "no-store", signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 10_000),
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${this.cfg.token}`, "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28", "X-Idempotency-Key": key },
        body: JSON.stringify({ labels: [LABEL_OF[rec.agent], "status:ready"] }),
      });
      if (res.ok) return { outcome: "accepted" };
      if (res.status >= 500 || res.status === 408) return { outcome: "unknown", error: `http ${res.status}` };
      return { outcome: "rejected_not_accepted", error: `http ${res.status}` }; // 4xx: definitively not applied
    } catch {
      return { outcome: "unknown", error: "transport error or timeout (ack may be lost)" }; // never leak token/err detail
    }
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
