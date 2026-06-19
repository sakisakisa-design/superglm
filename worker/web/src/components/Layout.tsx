import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { forgetKey } from "../auth";

export type Tab = "overview" | "providers" | "aliases" | "traces";

export function Layout({
  tab,
  setTab,
  children,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  children: ReactNode;
}) {
  const [baseUrl, setBaseUrl] = useState("");

  useEffect(() => {
    try {
      setBaseUrl(new URL(window.location.href).origin);
    } catch {
      setBaseUrl("");
    }
  }, []);

  const items: Array<{ id: Tab; label: string }> = [
    { id: "overview", label: "Overview" },
    { id: "providers", label: "Providers" },
    { id: "aliases", label: "Aliases" },
    { id: "traces", label: "Traces" },
  ];

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="dot" />
          <span>SuperDeepSeek</span>
        </div>
        {items.map((it) => (
          <div
            key={it.id}
            className={`nav-item ${tab === it.id ? "active" : ""}`}
            onClick={() => setTab(it.id)}
          >
            {it.label}
          </div>
        ))}
        <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 8, padding: "8px 0" }}>
          <button className="forget-btn" onClick={forgetKey}>Forget key</button>
          <div className="muted" style={{ fontSize: 11 }}>{baseUrl}</div>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
