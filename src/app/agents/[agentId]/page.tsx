import { AgentDetailScreen } from "@/components/workspace/WorkspaceScreens";
export default async function Page({params}:{params:Promise<{agentId:string}>}) { const {agentId}=await params; return <AgentDetailScreen agentId={agentId}/>; }
