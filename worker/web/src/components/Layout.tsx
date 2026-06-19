import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { forgetKey } from "../auth";

export type Tab = "overview" | "setup" | "providers" | "profiles" | "claude" | "traces" | "sanitizer" | "settings";

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

  const groups: Array<{ title: string; items: Array<{ id: Tab; label: string; hint?: string }> }> = [
    {
      title: "主功能",
      items: [
        { id: "overview", label: "概览" },
        { id: "setup", label: "配置向导" },
        { id: "providers", label: "上游服务" },
        { id: "profiles", label: "模型方案" },
      ],
    },
    {
      title: "观测",
      items: [
        { id: "claude", label: "Claude Code", hint: "核心" },
        { id: "traces", label: "请求追踪" },
        { id: "sanitizer", label: "清洗与缓存" },
      ],
    },
    {
      title: "系统",
      items: [{ id: "settings", label: "设置" }],
    },
  ];

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="dot" />
          <div>
            <div>superglm</div>
            <div className="muted" style={{ fontSize: 11, fontWeight: 500 }}>Cloudflare gateway</div>
          </div>
        </div>
        {groups.map((group) => (
          <div key={group.title} className="nav-group">
            <div className="group-title">{group.title}</div>
            {group.items.map((it) => (
              <button
                key={it.id}
                className={`nav-item ${tab === it.id ? "active" : ""}`}
                onClick={() => setTab(it.id)}
              >
                <span>{it.label}</span>
                {it.hint && <span className="nav-hint">{it.hint}</span>}
              </button>
            ))}
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
