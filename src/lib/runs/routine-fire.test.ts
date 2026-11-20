import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { MemoryRunStore, type RunStore } from "./store";
import { reserveRoutineFire, noteRoutineFireOutcome, inspectRoutineFireRecovery, RoutineFireConflict, type FireScope } from "./routine-fire";
import type { DispatchRecord } from "./run-tracking";
import type { Collaboration } from "./collaboration";

const AT = "2026-11-20T10:00:00.000Z";
const SHA = "8".repeat(40);
const D = createHash("sha256").update("approved work", "utf8").digest("hex");
const scope: FireScope = {
  dispatchId: "w-uuid-1-claude", workflowId: "uuid", issueNumber: 201,
  targetSha: SHA, approvalDigest: D
};
async function setup(enabled = true): Promise<MemoryRunStore> {
  const s = new MemoryRunStore();
  await s.transact(d => {
    d.control.agents["claude-sonnet"] = enabled;
    d.control.claudeProvider = enabled;
    d.collaborations = {
      uuid: { id:"uuid", stage:"claude", dispatchId:scope.dispatchId,
        assignment:{repo:"jonghee1998/ai-orchestrator",issueNumber:201,
          baseBranch:"claude/src",baseSha:SHA,sourcePr:193,
          workBranch:"claude/work",claudeAgent:"claude-sonnet",
          instructions:"approved work",reviewCompletedPr:false} } as Collaboration
    };
    d.records[scope.dispatchId] = {
      dispatchId:scope.dispatchId, issueNumber:201, agent:"claude-sonnet",
      status:"dispatched", submission:"accepted", submitAuthorizedAt:AT,
      collaboration: {
        workflowId:"uuid",cycle:1,step:"claude",repo:"jonghee1998/ai-orchestrator",
        baseBranch:"claude/src",baseSha:SHA,targetSha:SHA,
        workBranch:"claude/work",instructions:"approved work"
      }
    } as DispatchRecord;
  });
  return s;
}
async function denied(action: Promise<unknown>, reason: string) {
  await assert.rejects(action, (e: unknown) =>
    e instanceof RoutineFireConflict && e.message === reason);
}
test("reserve once, durable on duplicate and concurrent attempts; no automatic second fire",async()=>{
  const s=await setup();
  const attempts=await Promise.all([reserveRoutineFire(s,scope,AT),reserveRoutineFire(s,scope,AT)]);
  assert.equal(attempts.filter(x=>x.reserved).length,1);
  assert.equal(attempts.filter(x=>!x.reserved).length,1);
  const d=await s.read();
  assert.equal(Object.keys(d.routineFires??{}).length,1);
  await denied(reserveRoutineFire(s,{...scope,approvalDigest:"b".repeat(64)},AT),"reservation_scope_mismatch");
});
test("OFF gate, missing submit authorization, stale target SHA or wrong source all blocked",async()=>{
  const off=await setup(false);
  await denied(reserveRoutineFire(off,scope,AT),"control_gate_denied");
  for(const mutate of [
    (r:DispatchRecord)=>{r.submitAuthorizedAt=undefined;},
    (r:DispatchRecord)=>{r.submission="unknown";},
    (r:DispatchRecord)=>{r.collaboration!.targetSha="9".repeat(40);},
    (r:DispatchRecord)=>{r.runId="session-started";},
    (r:DispatchRecord)=>{r.agent="claude-opus";}
  ]) {
    const s=await setup();
    await s.transact(d=>{mutate(d.records[scope.dispatchId]);});
    await denied(reserveRoutineFire(s,scope,AT),"dispatch_not_authorized_or_ready");
  }
});
test("approval digest matches persisted instructions and workflow assignment boundaries",async()=>{
  const arbitrary=await setup();
  await denied(reserveRoutineFire(arbitrary,{...scope,approvalDigest:"a".repeat(64)},AT),"dispatch_not_authorized_or_ready");
  const edited=await setup();
  await edited.transact(d=>{d.records[scope.dispatchId].collaboration!.instructions="changed after approval";});
  await denied(reserveRoutineFire(edited,scope,AT),"dispatch_not_authorized_or_ready");
  const wrongIssue=await setup();
  await wrongIssue.transact(d=>{d.collaborations!.uuid.assignment.issueNumber=194;});
  await denied(reserveRoutineFire(wrongIssue,scope,AT),"dispatch_not_authorized_or_ready");
  const wrongBranch=await setup();
  await wrongBranch.transact(d=>{d.collaborations!.uuid.assignment.workBranch="claude/other";});
  await denied(reserveRoutineFire(wrongBranch,scope,AT),"dispatch_not_authorized_or_ready");
});
test("other claimed branch writer remains unsafe despite timeout status",async()=>{
  const s=await setup();
  await s.transact(d=>{d.records["other"]={
    ...d.records[scope.dispatchId],dispatchId:"other",status:"timeout",runId:"still-writing",
    collaboration:{...d.records[scope.dispatchId].collaboration!,workflowId:"other-workflow"}
  };});
  await denied(reserveRoutineFire(s,scope,AT),"writer_not_quiescent");
});
test("different dispatch same branch cannot refire after ambiguous outcome",async()=>{
  const s=await setup();
  assert.equal((await reserveRoutineFire(s,scope,AT)).reserved,true);
  await noteRoutineFireOutcome(s,scope.dispatchId,{state:"outcome_unknown"});
  await s.transact(d=>{
    const previous=d.records[scope.dispatchId];
    d.records["next"]={...previous,dispatchId:"next"};
    d.collaborations!.next={id:"next",stage:"claude",dispatchId:"next",assignment:{...d.collaborations!.uuid.assignment}} as Collaboration;
    d.records["next"].collaboration={...previous.collaboration!,workflowId:"next"};
  });
  await denied(reserveRoutineFire(s,{...scope,dispatchId:"next",workflowId:"next"},AT),"prior_fire_not_reconciled");
  assert.equal((await reserveRoutineFire(s,scope,AT)).reserved,false);
});
test("receipt is observational only, replay identical receipt allowed, mismatch blocked",async()=>{
  const s=await setup();await reserveRoutineFire(s,scope,AT);
  const receipt={state:"session_created" as const,sessionId:"session_01HJKLMNOPQRSTUVWXYZ",
    sessionUrl:"https://claude.ai/code/session_01HJKLMNOPQRSTUVWXYZ"};
  const saved=await noteRoutineFireOutcome(s,scope.dispatchId,receipt);
  assert.equal(saved.state,"session_created");
  assert.equal((await noteRoutineFireOutcome(s,scope.dispatchId,receipt)).sessionId,receipt.sessionId);
  await denied(noteRoutineFireOutcome(s,scope.dispatchId,{state:"outcome_unknown"}),"outcome_conflict");
  assert.equal((await reserveRoutineFire(s,scope,AT)).reserved,false);
});
test("reservation does not survive missing workflow or changed owner root",async()=>{
  const s=await setup();
  await s.transact(d=>{delete d.collaborations!.uuid;});
  await denied(reserveRoutineFire(s,scope,AT),"dispatch_not_authorized_or_ready");
});

test("read-only recovery: missing, reserved and ambiguous outcomes remain fenced",async()=>{
  const s=await setup();
  const missing=await inspectRoutineFireRecovery(s,scope.dispatchId);
  assert.equal(missing.reason,"reservation_missing_or_unknown");
  assert.equal(missing.canAutoRefire,false);
  await reserveRoutineFire(s,scope,AT);
  assert.equal((await inspectRoutineFireRecovery(s,scope.dispatchId)).reason,"fire_outcome_unconfirmed");
  await noteRoutineFireOutcome(s,scope.dispatchId,{state:"outcome_unknown"});
  assert.equal((await inspectRoutineFireRecovery(s,scope.dispatchId)).canAutoRefire,false);
});
test("session created, unclaimed, or self-reported finished never proves quiescence",async()=>{
  const s=await setup();await reserveRoutineFire(s,scope,AT);
  await noteRoutineFireOutcome(s,scope.dispatchId,{
    state:"session_created",sessionId:"session_01HJKLMNOPQRSTUVWXYZ",
    sessionUrl:"https://claude.ai/code/session_01HJKLMNOPQRSTUVWXYZ"
  });
  assert.equal((await inspectRoutineFireRecovery(s,scope.dispatchId)).reason,"session_created_not_claimed");
  await s.transact(d=>{
    const r=d.records[scope.dispatchId];
    r.runId="session_01HJKLMNOPQRSTUVWXYZ";r.runOrigin="session";
    r.status="succeeded";
    r.execution={exitCode:0,summary:"self report",headSha:SHA,tests:[],
      attestation:"external_session_self_report"};
  });
  const result=await inspectRoutineFireRecovery(s,scope.dispatchId);
  assert.equal(result.reason,"session_quiescence_unverifiable");
  assert.equal(result.canAutoRefire,false);
});
test("runner cleanup shows proof but cannot authorize fresh provider fire",async()=>{
  const s=await setup();await reserveRoutineFire(s,scope,AT);
  await noteRoutineFireOutcome(s,scope.dispatchId,{
    state:"session_created",sessionId:"session_01HJKLMNOPQRSTUVWXYZ",
    sessionUrl:"https://claude.ai/code/session_01HJKLMNOPQRSTUVWXYZ"
  });
  await s.transact(d=>{
    const r=d.records[scope.dispatchId];r.runId="runner-12345678";r.runOrigin="runner";
    r.status="timeout";
  });
  assert.equal((await inspectRoutineFireRecovery(s,scope.dispatchId)).reason,"runner_not_quiescent");
  await s.transact(d=>{
    d.records[scope.dispatchId].quiescence={at:AT,runId:"runner-12345678",
      reason:"lease_revoked",signal:"SIGKILL"};
  });
  const proof=await inspectRoutineFireRecovery(s,scope.dispatchId);
  assert.equal(proof.reason,"runner_quiescence_proven_but_reservation_still_held");
  assert.equal(proof.nextActor,"pm");
  assert.equal(proof.canAutoRefire,false);
});
test("record mismatch never becomes retry authorization",async()=>{
  const s=await setup();await reserveRoutineFire(s,scope,AT);
  await s.transact(d=>{d.records[scope.dispatchId].issueNumber=999;});
  assert.equal((await inspectRoutineFireRecovery(s,scope.dispatchId)).reason,"record_missing_or_mismatch");
});

test("forged session cleanup or quiescence NEVER releases a same-branch writer",async()=>{
  const s=await setup();
  await s.transact(d=>{
    const prior=d.records[scope.dispatchId];
    d.records["prior"]={
      ...prior,dispatchId:"prior",status:"succeeded",
      runId:"session_12345678",runOrigin:"session",
      execution:{exitCode:0,headSha:SHA,summary:"untrusted session",tests:[],
        cleanup:{processGroupsEmpty:true,groups:0}},
      quiescence:{at:AT,runId:"session_12345678",reason:"lease_revoked",signal:null},
      collaboration:{...prior.collaboration!,workflowId:"prior-workflow"}
    };
  });
  await denied(reserveRoutineFire(s,scope,AT),"writer_not_quiescent");
  await s.transact(d=>{d.records["prior"].runOrigin="runner";});
  assert.equal((await reserveRoutineFire(s,scope,AT)).reserved,true);
});
