import { useEffect, useState } from "react";
import { api, type Overview } from "../api";

export function Overview() {
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
    <div className="col">
      <h1>SuperDeepSeek Worker</h1>
      <p className="sub">Cloudflare-native AI gateway · mode: <code>{data.config.runtime?.mode ?? "observe"}</code></p>

      <div className="grid grid-3">
        <div className="card stat"><div className="num">{data.stats.providers}</div><div className="label">Providers</div></div>
        <div className="card stat"><div className="num">{data.stats.aliases}</div><div className="label">Aliases</div></div>
        <div className="card stat"><div className="num">{data.stats.traces}</div><div className="label">Recent traces</div></div>
      </div>

      <div className="card col">
        <h2>Claude Code compatibility</h2>
        <div className="row">
          <span className={`badge ${haiku ? "ok" : "warn"}`}>{haiku ? "haiku alias present" : "no haiku alias"}</span>
          <button className="primary" onClick={runSmoke}>Run smoke test</button>
        </div>
        {smoke && (
          <div className="pre">
            {`export ANTHROPIC_BASE_URL="${smoke.env.ANTHROPIC_BASE_URL}"\nexport ANTHROPIC_API_KEY="${smoke.env.ANTHROPIC_API_KEY}"\nclaude`}
          </div>
        )}
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
