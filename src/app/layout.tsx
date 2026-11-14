import type { Metadata, Viewport } from "next";
import "./globals.css";
import { BottomNav } from "@/components/BottomNav";
import { SampleBanner } from "@/components/SampleBanner";
import { SAMPLE_MODE } from "@/lib/data";

export const metadata: Metadata = {
  title: "AI Orchestrator",
  description:
    "ChatGPT·Codex·Claude Code·Pickle을 GitHub 중심으로 관리하는 개인 AI 오케스트레이션 대시보드",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0a0b0e",
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
          {SAMPLE_MODE && <SampleBanner />}
          <main className="flex-1 px-4 pb-24 pt-4">{children}</main>
          <BottomNav />
        </div>
      </body>
    </html>
  );
}
