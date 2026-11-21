"use client";
import { createContext, useContext, useEffect, useState } from "react";
import { refreshCenter } from "@/components/live/refresh";
type Info = { demo: false } | { demo: true; scenario: string; scenarios: string[] } | { demo: "blocked"; reason: string };
const Context = createContext<{ info: Info; loaded: boolean; select: (scenario: string) => Promise<void> }>({ info: { demo: false }, loaded: false, select: async () => {} });
export function DemoProvider({ children }: { children: React.ReactNode }) {
  const [info, setInfo] = useState<Info>({ demo: false });
  const [loaded, setLoaded] = useState(false);
  useEffect(() => { let active = true; fetch("/api/demo", { cache: "no-store" }).then(async r => { const j = await r.json(); if (active) { setInfo(j); setLoaded(true); } }).catch(() => {}); return () => { active = false; }; }, []);
  const select = async (scenario: string) => {
    try { const r = await fetch("/api/demo", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scenario }) }); if (r.ok) { setInfo(await r.json()); await refreshCenter.refreshAll(); } } catch { /* keep the last successfully selected scenario */ }
  };
  return <Context.Provider value={{ info, loaded, select }}>{children}</Context.Provider>;
}
export const useDemo = () => useContext(Context);
