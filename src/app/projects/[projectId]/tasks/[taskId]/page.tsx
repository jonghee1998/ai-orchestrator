import { ProjectsScreen } from "@/components/workspace/WorkspaceScreens";
export default async function Page({ params }: { params: Promise<{ projectId: string; taskId: string }> }) {
  const { projectId, taskId } = await params;
  return <ProjectsScreen projectId={projectId} taskId={taskId} />;
}
