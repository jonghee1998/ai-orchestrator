import {createHash} from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import {validateTransportConfig,validateAssignmentForTransport,submitAssignment} from "./transport-contract.mjs";
const sha="88bd2c4c791fda4afaa7ab0b4ce9b25b96be464e";
const a={repo:"jonghee1998/ai-orchestrator",issueNumber:201,sourcePr:193,
 baseSha:sha,baseBranch:"claude/determined-carson-s55tbd",workBranch:"claude/phase-b-oracle-201",
 claudeAgent:"claude-sonnet",reviewCompletedPr:false,instructions:"Phase B pure oracle only; no Phase C"};
const digest=createHash("sha256").update(a.instructions,"utf8").digest("hex");
const approved={instructionsSha256:digest,phase:"bridge-phase2",source:"owner-scoped-approval",allowed:true,issueNumber:201,sourcePr:193,
 baseSha:sha,baseBranch:a.baseBranch,workBranch:a.workBranch};
const config={origin:"https://controlled-preview.vercel.app",expectedHost:"controlled-preview.vercel.app",
 adminToken:"example-not-a-real-secret-1234"};
test("origin and secrets fail closed",()=>{
 assert.equal(validateTransportConfig(config),null);
 for(const origin of ["http://controlled-preview.vercel.app","https://evil.test","https://controlled-preview.vercel.app@evil.test",
 "https://controlled-preview.vercel.app/other","https://controlled-preview.vercel.app?bypass=x"]){
   assert.notEqual(validateTransportConfig({...config,origin}),null);
 }
 assert.notEqual(validateTransportConfig({...config,expectedHost:"other-preview.vercel.app"}),null);
 assert.notEqual(validateTransportConfig({...config,adminToken:""}),null);
});
test("scope must be a trusted, exact tuple, not event content",()=>{
 assert.equal(validateAssignmentForTransport(a,approved),null);
 assert.equal(validateAssignmentForTransport(a,null),"approval_missing");
 assert.equal(validateAssignmentForTransport(a,{...approved,source:"issue_comment"}),"approval_missing");
 assert.equal(validateAssignmentForTransport({...a,issueNumber:202},approved),"scope_mismatch");
 assert.equal(validateAssignmentForTransport({...a,baseSha:"f".repeat(40)},approved),"scope_mismatch");
 assert.equal(validateAssignmentForTransport({...a,reviewCompletedPr:true},approved),"invalid_assignment");
 assert.equal(validateAssignmentForTransport({...a,instructions:"Delete all records"},approved),"scope_mismatch");
 assert.equal(validateAssignmentForTransport(a,{...approved,instructionsSha256:"f".repeat(40)}),"scope_mismatch");
 assert.equal(validateAssignmentForTransport({...a,instructions:""},approved),"invalid_assignment");
});
test("no request at all if scope or auth absent",async()=>{
 let count=0;
 const request=async()=>{count++;throw new Error("must not call");};
 assert.equal((await submitAssignment({config,assignment:a,approved:null,request})).reason,"approval_missing");
 assert.equal((await submitAssignment({config:{...config,adminToken:""},assignment:a,approved,request})).reason,"missing_admin_token");
 assert.equal(count,0);
});
test("one POST only, response is an accepted workflow, never START",async()=>{
 let calls=0;
 const request=async(url,options)=>{
  calls++;assert.equal(url,"https://controlled-preview.vercel.app/api/collaboration");
  assert.equal(options.method,"POST");assert.equal(options.redirect,"error");
  assert.equal(options.headers["x-admin-token"],config.adminToken);
  assert.deepEqual(JSON.parse(options.body),{action:"assign",assignment:a});
  return {status:200,json:async()=>({workflow:{id:"verified-workflow",stage:"claude",dispatchId:"dispatch",
   assignment:a},submission:{ok:true,record:{dispatchId:"dispatch",agent:"claude-sonnet",issueNumber:201,
   collaboration:{workflowId:"verified-workflow",targetSha:sha},
   submitAuthorizedAt:"2026-11-20T00:00:00.000Z",submission:"accepted",status:"dispatched"}}})};
 };
 const res=await submitAssignment({config,assignment:a,approved,request});
 assert.deepEqual(res,{ok:true,workflowId:"verified-workflow",dispatchId:"dispatch",stage:"claude",
 submissionOutcome:"accepted",agentStarted:false});
 assert.equal(calls,1);
});
test("ambiguous timeout or response mismatch never triggers automatic retry",async()=>{
 let calls=0;
 const timeout=async()=>{calls++;throw new Error("network timeout");};
 assert.equal((await submitAssignment({config,assignment:a,approved,request:timeout})).reason,"transport_unknown_DO_NOT_RETRY");
 assert.equal(calls,1);
 const incorrect=async()=>({status:200,json:async()=>({workflow:{id:"x",stage:"claude",assignment:{...a,baseSha:"f".repeat(40)}}})});
 const alteredInstructions=async()=>({status:200,json:async()=>({workflow:{id:"x",stage:"claude",assignment:{...a,instructions:"forged"}}})});
 assert.equal((await submitAssignment({config,assignment:a,approved,request:alteredInstructions})).reason,"response_mismatch_DO_NOT_RETRY");
 assert.equal((await submitAssignment({config,assignment:a,approved,request:incorrect})).reason,"response_mismatch_DO_NOT_RETRY");
});

test("HTTP 200 with Sonnet OFF, unknown ACK or mismatched dispatch cannot wake Claude",async()=>{
 const workflow={id:"verified-workflow",stage:"claude",dispatchId:"dispatch",assignment:a};
 const record={dispatchId:"dispatch",agent:"claude-sonnet",issueNumber:201,
   collaboration:{workflowId:"verified-workflow",targetSha:sha},
   submitAuthorizedAt:"2026-11-20T00:00:00.000Z",submission:"accepted",status:"dispatched"};
 for(const sub of [
  {ok:false,stage:"gate",reason:"agent_disabled"},
  {ok:true,record:{...record,submission:"unknown"}},
  {ok:true,record:{...record,dispatchId:"other"}},
  {ok:true,record:{...record,submitAuthorizedAt:undefined}},
  {ok:true,record:{...record,agent:"claude-opus"}},
  {ok:true,record:{...record,status:"running",runId:"claimed-session-12345"}},
  {ok:true,record:{...record,status:"running"}},
  {ok:true,record:{...record,status:"dispatched",runId:"claimed-session-12345"}},
  {ok:true,record:{...record,collaboration:{...record.collaboration,targetSha:"f".repeat(40)}}}
 ]) {
  let calls=0;
  const request=async()=>{calls++;return {status:200,json:async()=>({workflow,submission:sub})};};
  const result=await submitAssignment({config,assignment:a,approved,request});
  assert.equal(result.ok,false);
  assert.equal(result.reason,"assignment_not_dispatched_DO_NOT_RETRY");
  assert.equal(result.agentStarted,false);
  assert.equal(calls,1);
 }
});
