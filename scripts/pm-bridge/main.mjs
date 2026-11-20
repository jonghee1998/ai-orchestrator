// Phase 1 read-only Github hint planner, intentionally has no Vercel call or write method.
import {readFile,appendFile} from "node:fs/promises";
import {eventCandidate,verifySnapshot,REPO} from "./core.mjs";
async function report(message){process.stdout.write(message+"\n");if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,message+"\n");}
const token=process.env.GITHUB_TOKEN,file=process.env.GITHUB_EVENT_PATH;
if(!token||!file)throw new Error("missing_readonly_github_context");
const event=JSON.parse(await readFile(file,"utf8"));
const candidate=eventCandidate(event);
if(!candidate.ok){await report("PM bridge dry-run IGNORE: "+candidate.reason);process.exit(0);}
const a=candidate.instruction;
async function get(path){
 const res=await fetch("https://api.github.com/repos/"+REPO+path,{method:"GET",cache:"no-store",redirect:"error",
 signal:AbortSignal.timeout(10000),headers:{Authorization:"Bearer "+token,Accept:"application/vnd.github+json",
 "X-GitHub-Api-Version":"2022-11-28"}});
 if(!res.ok)throw new Error("github_evidence_unavailable_http_"+res.status);
 return res.json();
}
try{
 const [comment,issue,pr,sourceBranch]=await Promise.all([
 get("/issues/comments/"+candidate.commentId),get("/issues/"+a.issueNumber),
 get("/pulls/"+a.sourcePr),get("/branches/"+encodeURIComponent(a.sourceBranch))]);
 const verdict=verifySnapshot(candidate,{comment,issue,pr,branch:sourceBranch});
 if(!verdict.ok){await report("PM bridge dry-run BLOCKED: "+verdict.reason);process.exitCode=1;}
 else await report("PM bridge dry-run VERIFIED: issue #"+a.issueNumber+" PR #"+a.sourcePr+" SHA "+a.sourceSha+"; no dispatch, no Sonnet start");
}catch{await report("PM bridge dry-run BLOCKED: live GitHub evidence unavailable");process.exitCode=1;}
