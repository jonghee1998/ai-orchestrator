import { LiveProjectsScreen } from "@/components/workspace/LiveScreens";
export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <LiveProjectsScreen projectId={projectId} />;
}
