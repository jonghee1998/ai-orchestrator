"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const items = [
  { href: "/", label: "홈", icon: "◆" },
  { href: "/projects", label: "프로젝트", icon: "▤" },
  { href: "/agents", label: "에이전트", icon: "◉" },
  { href: "/control", label: "제어", icon: "⏻" },
  { href: "/tasks", label: "큐", icon: "☰" },
  { href: "/activity", label: "활동", icon: "↻" },
];

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-bg-raised/95 backdrop-blur">
      <div className="mx-auto flex max-w-app items-stretch justify-around">
        {items.map((item) => {
          const active =
            item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex flex-1 flex-col items-center gap-1 py-2.5 text-[11px] transition-colors ${
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
