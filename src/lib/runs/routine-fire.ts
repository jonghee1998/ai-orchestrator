import { createHash } from "node:crypto";
// Isolated storage contract: not called by any route/workflow. No external Routine POST here.
// Caller authentication, owner-approved scope, and latest GitHub HEAD evidence MUST be
// independently checked before reserving. Reservation is NOT itself task authorization.
import type { RunStore, RoutineFireReservation } from "./store";
import { evaluateGate } from "../control/model";
import { provablyQuiescent } from "./collaboration";

const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
export class RoutineFireConflict extends Error { name = "RoutineFireConflict"; }

export interface FireScope {
  dispatchId: string;
  workflowId: string;
  issueNumber: number;
  targetSha: string;
  approvalDigest: string;
}

export async function reserveRoutineFire(
  store: RunStore, scope: FireScope, at: string
): Promise<{ reserved: boolean; record: RoutineFireReservation }> {
  if (!scope || typeof scope.dispatchId !== "string" || !scope.dispatchId ||
      typeof scope.workflowId !== "string" || !scope.workflowId ||
      !Number.isSafeInteger(scope.issueNumber) || scope.issueNumber <= 0 ||
      !SHA.test(scope.targetSha) || !DIGEST.test(scope.approvalDigest) ||
      !Number.isFinite(Date.parse(at))) throw new RoutineFireConflict("invalid_scope");

  return store.transact(d => {
    const existing = d.routineFires?.[scope.dispatchId];
    if (existing) {
      if (existing.workflowId !== scope.workflowId ||
          existing.issueNumber !== scope.issueNumber ||
          existing.targetSha !== scope.targetSha ||
          existing.approvalDigest !== scope.approvalDigest)
        throw new RoutineFireConflict("reservation_scope_mismatch");
      return { reserved: false, record: structuredClone(existing) };
    }

    const rec = d.records[scope.dispatchId];
    const w = d.collaborations?.[scope.workflowId];
    if (!rec?.collaboration || !w || !w.assignment || rec.collaboration.workflowId !== scope.workflowId ||
        w.dispatchId !== scope.dispatchId || w.stage !== "claude" ||
        rec.collaboration.step !== "claude" || rec.agent !== "claude-sonnet" ||
        rec.collaboration.targetSha !== scope.targetSha ||
        w.assignment.repo.toLowerCase() !== rec.collaboration.repo.toLowerCase() ||
        w.assignment.issueNumber !== rec.issueNumber ||
        w.assignment.baseBranch !== rec.collaboration.baseBranch ||
        w.assignment.baseSha !== rec.collaboration.baseSha ||
        w.assignment.workBranch !== rec.collaboration.workBranch ||
        createHash("sha256").update(rec.collaboration.instructions, "utf8").digest("hex") !== scope.approvalDigest ||
        rec.issueNumber !== scope.issueNumber || rec.runId ||
        !rec.submitAuthorizedAt || rec.submission !== "accepted" ||
        rec.status !== "dispatched" || rec.held)
      throw new RoutineFireConflict("dispatch_not_authorized_or_ready");

    const decision = evaluateGate(d.control, "claude-sonnet", Date.parse(at));
    if (!decision.allowed) throw new RoutineFireConflict("control_gate_denied");

    // A claimed previous writer on this branch is NOT made safe by timeout or
    // a terminal GitHub status: only runner cleanup proof/quiescence can clear it.
    const activeWriter = Object.values(d.records).some(other =>
      other.dispatchId !== scope.dispatchId &&
      other.collaboration?.step === "claude" &&
      other.collaboration.repo.toLowerCase() === rec.collaboration!.repo.toLowerCase() &&
      other.collaboration.workBranch.toLowerCase() === rec.collaboration!.workBranch.toLowerCase() &&
      !!other.runId && !provablyQuiescent(other));
    if (activeWriter) throw new RoutineFireConflict("writer_not_quiescent");

    // A prior reservation on the same physical work branch is also a writer
    // candidate, even when the corresponding dispatch has no confirmed claim yet.
    // The session may have started despite a lost HTTP reply. Never fire twice.
    for (const prior of Object.values(d.routineFires ?? {})) {
      const previous = d.records[prior.dispatchId];
      if (previous?.collaboration?.repo.toLowerCase() === rec.collaboration.repo.toLowerCase() &&
          previous.collaboration.workBranch.toLowerCase() === rec.collaboration.workBranch.toLowerCase())
        throw new RoutineFireConflict("prior_fire_not_reconciled");
    }

    const record: RoutineFireReservation = {
      dispatchId: scope.dispatchId, workflowId: scope.workflowId,
      issueNumber: scope.issueNumber, targetSha: scope.targetSha,
      approvalDigest: scope.approvalDigest, reservedAt: at, state: "reserved"
    };
    (d.routineFires ??= {})[scope.dispatchId] = record;
    return { reserved: true, record: structuredClone(record) };
  });
}

// Only improves observability. Never releases or re-fires a reservation.
export async function noteRoutineFireOutcome(store: RunStore, dispatchId: string,
  outcome: { state: "session_created"; sessionId: string; sessionUrl: string } |
           { state: "outcome_unknown" }
): Promise<RoutineFireReservation> {
  return store.transact(d => {
    const record = d.routineFires?.[dispatchId];
    if (!record) throw new RoutineFireConflict("reservation_missing");
    if (record.state !== "reserved") {
      if (record.state !== outcome.state ||
        (outcome.state === "session_created" &&
         (record.sessionId !== outcome.sessionId || record.sessionUrl !== outcome.sessionUrl)))
        throw new RoutineFireConflict("outcome_conflict");
      return structuredClone(record);
    }
    if (outcome.state === "session_created") {
      if (!/^session_[A-Za-z0-9_-]{8,128}$/.test(outcome.sessionId) ||
          !/^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9_-]{8,128}$/.test(outcome.sessionUrl))
        throw new RoutineFireConflict("invalid_session_receipt");
      record.sessionId = outcome.sessionId;
      record.sessionUrl = outcome.sessionUrl;
    }
    record.state = outcome.state;
    return structuredClone(record);
  });
}
