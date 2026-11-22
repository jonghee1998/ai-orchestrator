"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// 시안(docs/design/projects-mock.html)의 SVG 아이콘: viewBox 24, 굵기 1.8, round.
const ICONS: Record<string, React.ReactNode> = {
  "/projects": <path d="M4 5h16M4 12h16M4 19h10" />,
  "/agents": (
    <>
      <circle cx="12" cy="8" r="3.2" />
      <path d="M5 20c1.2-3.6 4-5 7-5s5.8 1.4 7 5" />
    </>
  ),
  "/briefing": <path d="M5 4h14v12H9l-4 4z" />,
  "/patch-notes": (
    <>
      <path d="M7 3h7l4 4v14H7z" />
      <path d="M14 3v4h4M10 12h5M10 16h5" />
    </>
  ),
  "/architecture": (
    <>
      <rect x="4" y="4" width="6" height="6" />
      <rect x="14" y="14" width="6" height="6" />
      <path d="M7 10v4h7" />
    </>
  ),
};

const items = [
  { href: "/projects", label: "프로젝트" },
  { href: "/agents", label: "AI 팀" },
  { href: "/briefing", label: "PM 브리핑" },
  { href: "/patch-notes", label: "패치노트" },
  { href: "/architecture", label: "구조" },
];

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="주 메뉴" className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-bg-card pb-[env(safe-area-inset-bottom)]">
      <div className="mx-auto flex max-w-app items-stretch justify-around">
        {items.map((item) => {
          const active =
            item.href === "/projects"
              ? pathname === "/" || pathname.startsWith("/projects")
              : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`min-h-14 flex flex-1 flex-col items-center gap-1 py-2.5 text-[11px] transition-colors ${
                active ? "font-bold text-text" : "font-medium text-text-muted hover:text-text"
              }`}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                focusable="false"
                className="h-[22px] w-[22px]"
              >
                {ICONS[item.href]}
              </svg>
              <span>{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
