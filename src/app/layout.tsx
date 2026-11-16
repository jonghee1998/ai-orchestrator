import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AuthGate } from "@/components/AuthGate";
import { DemoProvider } from "@/components/workspace/DemoContext";
import { BottomNav } from "@/components/BottomNav";
import { DemoBanner } from "@/components/DemoBanner";
import { GlobalRefresh } from "@/components/GlobalRefresh";
import { SimulationProvider } from "@/components/workspace/SimulationContext";

export const metadata: Metadata = {
  title: "AI Orchestrator",
  description:
    "ChatGPT·Codex·Claude Code·Pickle을 GitHub 중심으로 관리하는 개인 AI 오케스트레이션 대시보드",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0B1220",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body>
        <div className="mx-auto flex min-h-dvh max-w-app flex-col">
          <AuthGate>
          <DemoProvider>
          <SimulationProvider>
          <GlobalRefresh />
          <DemoBanner />
          <main className="flex-1 px-4 pb-[calc(6rem+env(safe-area-inset-bottom))] pt-4">{children}</main>
          <BottomNav />
          </SimulationProvider>
          </DemoProvider>
          </AuthGate>
        </div>
      </body>
    </html>
  );
}
