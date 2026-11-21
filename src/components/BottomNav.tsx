"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const items = [
  { href: "/projects", label: "프로젝트", icon: "▤" },
  { href: "/agents", label: "AI 팀", icon: "◉" },
  { href: "/briefing", label: "PM 브리핑", icon: "◆" },
  { href: "/patch-notes", label: "패치노트", icon: "✎" },
];

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="주 메뉴" className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-bg-raised/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
      <div className="mx-auto flex max-w-app items-stretch justify-around">
        {items.map((item) => {
          const active =
            item.href === "/projects"
              ? pathname === "/" || pathname.startsWith("/projects")
              : pathname.startsWith(item.href) || (item.href === "/briefing" && pathname.startsWith("/activity"));
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`min-h-14 flex flex-1 flex-col items-center gap-1 py-2.5 text-[11px] transition-colors ${
                active ? "text-accent" : "text-text-faint hover:text-text-muted"
              }`}
            >
              <span className="text-base leading-none">{item.icon}</span>
              <span>{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
