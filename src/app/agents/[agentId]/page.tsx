import { LiveAgentsScreen } from "@/components/workspace/LiveScreens";
export default async function Page({params}:{params:Promise<{agentId:string}>}) { const {agentId}=await params; return <LiveAgentsScreen agentId={agentId}/>; }
