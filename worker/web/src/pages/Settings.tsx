import { useEffect, useState } from "react";
import { api, type GatewayConfig } from "../api";

export function Settings() {
  const [config, setConfig] = useState<GatewayConfig | null>(null);
  const [raw, setRaw] = useState("");
  const [msg, setMsg] = useState("");

  const load = async () => {
    const cfg = await api.getConfig();
    setConfig(cfg);
    setRaw(JSON.stringify(cfg, null, 2));
  };

  useEffect(() => { load().catch((e) => setMsg(String(e))); }, []);

  const saveBasic = async () => {
    if (!config) return;
    try {
      const saved = await api.saveConfig(config);
      setConfig(saved);
      setRaw(JSON.stringify(saved, null, 2));
      setMsg("Settings saved.");
    } catch (e) {
      setMsg(String(e));
    }
  };

  const saveRaw = async () => {
    try {
      const parsed = JSON.parse(raw) as GatewayConfig;
      const saved = await api.saveConfig(parsed);
      setConfig(saved);
      setRaw(JSON.stringify(saved, null, 2));
      setMsg("Raw config saved.");
    } catch (e) {
      setMsg(String(e));
    }
  };

  return (
    <div className="col page-wide">
      <div>
        <h1>设置</h1>
        <p className="sub">Worker runtime、安全、trace 保留时间和完整 JSON 配置。</p>
      </div>

      <div className="grid grid-2">
        <div className="card col">
          <h2>运行时</h2>
          <div className="field">
            <label>mode</label>
            <select value={config?.runtime?.mode ?? "observe"} onChange={(e) => setConfig(config ? { ...config, runtime: { ...(config.runtime ?? {}), mode: e.target.value } } : config)}>
              <option value="passthrough">passthrough</option>
              <option value="observe">observe</option>
              <option value="augment">augment</option>
              <option value="strict">strict</option>
            </select>
          </div>
          <div className="field">
            <label>default_profile</label>
            <input className="mono" value={config?.runtime?.default_profile ?? ""} onChange={(e) => setConfig(config ? { ...config, runtime: { ...(config.runtime ?? {}), default_profile: e.target.value } } : config)} />
          </div>
          <div className="field">
            <label>trace_retention_days</label>
            <input type="number" value={config?.runtime?.trace_retention_days ?? 7} onChange={(e) => setConfig(config ? { ...config, runtime: { ...(config.runtime ?? {}), trace_retention_days: Number(e.target.value) } } : config)} />
          </div>
          <button className="primary" onClick={saveBasic}>Save settings</button>
        </div>

        <div className="card col">
          <h2>安全</h2>
          <p className="muted">`SUPERDS_LOCAL_API_KEY` Worker secret 是首选 gateway key；API 响应永远不会回显真实 key。</p>
          <label className="switch-line">
            <input type="checkbox" checked={config?.security?.redact_secrets_in_logs !== false} onChange={(e) => setConfig(config ? { ...config, security: { ...(config.security ?? {}), redact_secrets_in_logs: e.target.checked } } : config)} />
            Redact secrets in traces
          </label>
          <label className="switch-line">
            <input type="checkbox" checked={config?.security?.bind_localhost_only === true} onChange={(e) => setConfig(config ? { ...config, security: { ...(config.security ?? {}), bind_localhost_only: e.target.checked } } : config)} />
            Local edition binds localhost only
          </label>
        </div>
      </div>

      <div className="card col">
        <h2>完整配置 JSON</h2>
        <textarea className="json-editor" value={raw} onChange={(e) => setRaw(e.target.value)} />
        <div className="row">
          <button onClick={() => load()}>Reload</button>
          <button className="primary" onClick={saveRaw}>Save JSON</button>
        </div>
      </div>

      {msg && <div className={`badge ${msg.includes("Error") || msg.includes("Syntax") ? "err" : "ok"}`}>{msg}</div>}
    </div>
  );
}
