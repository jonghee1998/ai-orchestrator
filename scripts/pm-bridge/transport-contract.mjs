import {createHash} from "node:crypto";
// Phase 2A: inert HTTP client and contract checks. NOT wired to any workflow/route.
const SHA=/^[a-f0-9]{40}$/;
const SHA256=/^[a-f0-9]{64}$/;
const instructionDigest = value => createHash("sha256").update(value,"utf8").digest("hex");
const HOST=/^[a-z0-9][a-z0-9.-]*\.vercel\.app$/;
export function validateTransportConfig(config){
 if(!config || typeof config!=="object") return "missing_config";
 let url;try{url=new URL(config.origin);}catch{return "invalid_origin";}
 if(url.protocol!=="https:"||!HOST.test(url.hostname)||url.username||url.password||url.search||url.hash||
    (url.pathname!=="/" && url.pathname!=="")||url.port)return "invalid_origin";
 if(typeof config.expectedHost!=="string"||url.hostname!==config.expectedHost)return "host_mismatch";
 if(typeof config.adminToken!=="string"||config.adminToken.trim().length<16)return "missing_admin_token";
 if(config.protectionBypass!==undefined && (typeof config.protectionBypass!=="string"||config.protectionBypass.length<16))return "invalid_protection_bypass";
 return null;
}
export function validateAssignmentForTransport(a, approved){
 if(!approved || approved.phase!=="bridge-phase2" || approved.source!=="owner-scoped-approval" ||
    approved.allowed!==true) return "approval_missing";
 if(!a || a.repo!=="jonghee1998/ai-orchestrator" ||
    !Number.isSafeInteger(a.issueNumber)||a.issueNumber<=0||
    !Number.isSafeInteger(a.sourcePr)||a.sourcePr<=0||
    a.claudeAgent!=="claude-sonnet"||a.reviewCompletedPr!==false||
    typeof a.baseSha!=="string"||!SHA.test(a.baseSha)||
    typeof a.baseBranch!=="string"||!a.baseBranch.length||
    typeof a.workBranch!=="string"||!a.workBranch.length||
    typeof a.instructions!=="string"||!a.instructions.trim()||
    a.instructions.length>8000) return "invalid_assignment";
 // Bound to a separately authorized, exact issue+PR+sha tuple. Never trust event marker alone.
 if(a.issueNumber!==approved.issueNumber||a.sourcePr!==approved.sourcePr||
    a.baseSha!==approved.baseSha||a.baseBranch!==approved.baseBranch||
    a.workBranch!==approved.workBranch ||
    typeof approved.instructionsSha256!=="string" || !SHA256.test(approved.instructionsSha256) ||
    instructionDigest(a.instructions)!==approved.instructionsSha256)return "scope_mismatch";
 return null;
}
// Do not call unless an independent, authenticated owner-scope proof has already been
// established and the protected deployment owner explicitly approved the credentials.
// This helper is not a security boundary: caller must validate approval provenance.
export async function submitAssignment({config,assignment,approved,request=fetch}){
 const cf=validateTransportConfig(config);if(cf)return {ok:false,reason:cf};
 const af=validateAssignmentForTransport(assignment,approved);if(af)return {ok:false,reason:af};
 const url=new URL("/api/collaboration",config.origin).href;
 let response;
 try{
  response=await request(url,{method:"POST",redirect:"error",cache:"no-store",
    signal:AbortSignal.timeout(10000),
    headers:{"content-type":"application/json","x-admin-token":config.adminToken,
      ...(config.protectionBypass?{"x-vercel-protection-bypass":config.protectionBypass}:{})},
    body:JSON.stringify({action:"assign",assignment})});
 }catch{return {ok:false,reason:"transport_unknown_DO_NOT_RETRY"};}
 if(!response||response.status!==200)return {ok:false,reason:"http_not_accepted_DO_NOT_RETRY"};
 let json;try{json=await response.json();}catch{return {ok:false,reason:"invalid_response_DO_NOT_RETRY"};}
 const w=json?.workflow;
 if(!w || typeof w.id!=="string"||!w.id||
    w.assignment?.repo!==assignment.repo||w.assignment?.issueNumber!==assignment.issueNumber||
    w.assignment?.sourcePr!==assignment.sourcePr||w.assignment?.baseSha!==assignment.baseSha||
    w.assignment?.baseBranch!==assignment.baseBranch||w.assignment?.workBranch!==assignment.workBranch||
    w.assignment?.claudeAgent!==assignment.claudeAgent ||
    w.assignment?.instructions!==assignment.instructions ||
    w.assignment?.reviewCompletedPr!==assignment.reviewCompletedPr ||
    !["claude","blocked"].includes(w.stage))
   return {ok:false,reason:"response_mismatch_DO_NOT_RETRY"};
 // Workflow persistence and a 200 HTTP response are NOT dispatch authorization.
 // The existing server can return 200 with submission.ok=false (Sonnet OFF),
 // or submission.ok=true with record.submission="unknown" (GitHub ACK lost).
 // Neither may wake Claude; never auto-retry because the assignment may exist.
 const sub=json?.submission, record=sub?.record;
 if(w.stage!=="claude"||sub?.ok!==true||!record||
    typeof w.dispatchId!=="string"||!w.dispatchId||
    record.dispatchId!==w.dispatchId||record.agent!=="claude-sonnet"||
    record.issueNumber!==assignment.issueNumber||
    record.collaboration?.workflowId!==w.id||
    record.collaboration?.targetSha!==assignment.baseSha||
    !record.submitAuthorizedAt||!Number.isFinite(Date.parse(record.submitAuthorizedAt))||
    record.submission!=="accepted"||
    !["dispatched","running"].includes(record.status))
   return {ok:false,reason:"assignment_not_dispatched_DO_NOT_RETRY",workflowId:w.id,
     dispatchId:w.dispatchId??null,agentStarted:false};
 // Only a genuinely accepted, authorized and record-bound dispatch is ready.
 // This is still NOT an agent START / claim / completion certificate.
 return {ok:true,workflowId:w.id,dispatchId:w.dispatchId,stage:w.stage,
   submissionOutcome:"accepted",agentStarted:false};
}
