import { useEffect, useState } from "react";
import { api, type Overview } from "../api";
import type { Tab } from "../components/Layout";

export function Overview({ goto }: { goto: (tab: Tab) => void }) {
  const [data, setData] = useState<Overview | null>(null);
  const [err, setErr] = useState("");
  const [smoke, setSmoke] = useState<{ ok: boolean; base_url: string; env: Record<string, string> } | null>(null);

  useEffect(() => {
    api.overview().then(setData).catch((e) => setErr(String(e)));
  }, []);

  const runSmoke = async () => {
    try {
      setSmoke(await api.claudeSmoke());
    } catch (e) {
      setErr(String(e));
    }
  };

  if (err) return <div className="card badge err">{err}</div>;
  if (!data) return <div className="muted">Loading…</div>;

  const haiku = data.aliases.some((a) => a.alias.includes("haiku"));

  return (
    <div className="col page-wide">
      <div className="hero-panel">
        <div>
          <div className="crumbs">gateway / overview</div>
          <h1>superglm 控制面板</h1>
          <p className="sub">Cloudflare-native AI gateway · mode: <code>{data.config.runtime?.mode ?? "observe"}</code></p>
        </div>
        <div className="row">
          <button onClick={() => goto("setup")}>配置向导</button>
          <button className="primary" onClick={() => goto("claude")}>Claude Code</button>
        </div>
      </div>

      <div className="grid grid-3">
        <div className="card stat"><div className="num">{data.stats.providers}</div><div className="label">Providers</div></div>
        <div className="card stat"><div className="num">{data.stats.aliases}</div><div className="label">Aliases</div></div>
        <div className="card stat"><div className="num">{data.stats.traces}</div><div className="label">Recent traces</div></div>
      </div>

      <div className="grid grid-2">
        <div className="card col">
          <h2>上游健康</h2>
          <table>
            <thead><tr><th>provider</th><th>protocol</th><th>base_url</th><th>key</th></tr></thead>
            <tbody>
              {data.providers.length === 0 && <tr><td colSpan={4} className="muted">No providers yet.</td></tr>}
              {data.providers.map((p) => (
                <tr key={p.id}>
                  <td className="mono">{p.id}</td>
                  <td>{p.protocol}</td>
                  <td className="mono">{p.base_url}</td>
                  <td><span className={`badge ${p.api_key ? "ok" : "warn"}`}>{p.api_key ? "configured" : "missing"}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          <button onClick={() => goto("providers")}>管理上游服务</button>
        </div>

        <div className="card col">
          <h2>Claude Code compatibility</h2>
          <div className="row">
            <span className={`badge ${haiku ? "ok" : "warn"}`}>{haiku ? "haiku alias present" : "no haiku alias"}</span>
            <button className="primary" onClick={runSmoke}>Run smoke helper</button>
          </div>
          {smoke && (
            <div className="pre">
              {`export ANTHROPIC_BASE_URL="${smoke.env.ANTHROPIC_BASE_URL}"\nexport ANTHROPIC_API_KEY="${smoke.env.ANTHROPIC_API_KEY}"\nclaude`}
            </div>
          )}
          <button onClick={() => goto("claude")}>打开 Claude Code 兼容页</button>
        </div>
      </div>

      <div className="card col">
        <h2>Recent traces</h2>
        <table>
          <thead><tr><th>Time</th><th>Model in</th><th>Upstream</th><th>Status</th><th>Latency</th></tr></thead>
          <tbody>
            {data.recent_traces.length === 0 && (
              <tr><td colSpan={5} className="muted">No traces yet.</td></tr>
            )}
            {data.recent_traces.map((t) => (
              <tr key={t.trace_id}>
                <td className="mono">{t.trace_id}</td>
                <td className="mono">{t.incoming_model ?? "—"}</td>
                <td className="mono">{t.upstream_model ?? "—"}</td>
                <td><span className={`badge ${t.status === "success" ? "ok" : "err"}`}>{t.status}</span></td>
                <td className="mono">{t.latency_ms ?? "—"}ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
