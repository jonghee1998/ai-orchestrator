// PM Bridge Phase 1: pure read-only validation, NOT execution.
export const REPO="jonghee1998/ai-orchestrator";
export const PM_USER={login:"jonghee1998",id:129052128,type:"User"};
const SHA=/^[a-f0-9]{40}$/;
const BRANCH=/^[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$/;
const MARKER=/^<!-- gpt-pm-bridge:v1 (\{[^\r\n]*\}) -->$/;
export function validBranch(s){return typeof s==="string"&&BRANCH.test(s)&&!s.includes("..")&&!s.includes("//")&&!s.endsWith("/")&&!s.endsWith(".lock");}
export function parseInstruction(body){
 if(typeof body!=="string"||body.length>2048)return null;
 const match=MARKER.exec(body.trim());if(!match)return null;
 let a;try{a=JSON.parse(match[1]);}catch{return null;}
 const fields=["agent","issueNumber","sourceBranch","sourcePr","sourceSha","workBranch"];
 if(!a||typeof a!=="object"||Array.isArray(a)||Object.keys(a).sort().join(",")!==fields.sort().join(","))return null;
 if(a.agent!=="claude-sonnet"||!Number.isSafeInteger(a.issueNumber)||a.issueNumber<=0||!Number.isSafeInteger(a.sourcePr)||a.sourcePr<=0||
    typeof a.sourceSha!=="string"||!SHA.test(a.sourceSha)||!validBranch(a.sourceBranch)||!validBranch(a.workBranch)||
    ["main","master",a.sourceBranch].includes(a.workBranch))return null;
 return a;
}
export function trustedUser(user){return !!user&&user.login===PM_USER.login&&user.id===PM_USER.id&&user.type===PM_USER.type;}
export function eventCandidate(e){
 if(!e||e.action!=="created"||e.repository?.full_name!==REPO||!trustedUser(e.sender)||!trustedUser(e.comment?.user)||
    !Number.isSafeInteger(e.comment?.id)||e.comment.id<=0||e.issue?.pull_request||e.issue?.state!=="open"||
    !Number.isSafeInteger(e.issue?.number))return {ok:false,reason:"untrusted_or_unsupported_event"};
 const instruction=parseInstruction(e.comment.body);
 if(!instruction||instruction.issueNumber!==e.issue.number)return {ok:false,reason:"invalid_instruction"};
 return {ok:true,instruction,commentId:e.comment.id};
}
export function verifySnapshot(candidate,{comment,issue,pr,branch}){
 if(!candidate?.ok)return {ok:false,reason:"invalid_candidate"};
 const a=candidate.instruction;
 if(!comment||comment.id!==candidate.commentId||!trustedUser(comment.user)||
   comment.issue_url!=="https://api.github.com/repos/"+REPO+"/issues/"+a.issueNumber||
   JSON.stringify(parseInstruction(comment.body))!==JSON.stringify(a))return {ok:false,reason:"comment_changed_or_untrusted"};
 if(!issue||issue.number!==a.issueNumber||issue.state!=="open"||issue.pull_request)return {ok:false,reason:"issue_changed"};
 if(!pr||pr.number!==a.sourcePr||pr.state!=="open"||pr.head?.repo?.full_name!==REPO||
    pr.base?.repo?.full_name!==REPO||pr.head?.ref!==a.sourceBranch||pr.head?.sha!==a.sourceSha||
    !validBranch(pr.base?.ref))return {ok:false,reason:"source_pr_mismatch"};
 if(!branch||branch.name!==a.sourceBranch||branch.commit?.sha!==a.sourceSha)return {ok:false,reason:"head_moved"};
 return {ok:true,plan:{repo:REPO,issueNumber:a.issueNumber,sourcePr:a.sourcePr,baseBranch:a.sourceBranch,
 baseSha:a.sourceSha,workBranch:a.workBranch,claudeAgent:a.agent,reviewCompletedPr:false,
 mode:"dry_run",readyForSubmission:false}};
}
