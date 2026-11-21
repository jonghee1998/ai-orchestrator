import { LiveProjectsScreen } from "@/components/workspace/LiveScreens";
export default async function Page({ params }: { params: Promise<{ projectId: string; taskId: string }> }) {
  const { projectId, taskId } = await params;
  return <LiveProjectsScreen projectId={projectId} taskId={taskId} />;
}
