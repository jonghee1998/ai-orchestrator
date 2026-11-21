import { ProjectsScreen } from "@/components/workspace/WorkspaceScreens";
export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <ProjectsScreen projectId={projectId} />;
}
