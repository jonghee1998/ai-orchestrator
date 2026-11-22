import type { Metadata, Viewport } from "next";
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "./globals.css";
import { AuthGate } from "@/components/AuthGate";
import { BottomNav } from "@/components/BottomNav";

export const metadata: Metadata = {
  title: "AI Orchestrator",
  description:
    "ChatGPT·Codex·Claude Code·Pickle을 GitHub 중심으로 관리하는 개인 AI 오케스트레이션 대시보드",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#F6F7F9",
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
          <main className="flex-1 px-4 pb-[calc(6rem+env(safe-area-inset-bottom))] pt-[calc(1rem+env(safe-area-inset-top))]">{children}</main>
          <BottomNav />
          </AuthGate>
        </div>
      </body>
    </html>
  );
}
