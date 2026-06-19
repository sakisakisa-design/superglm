import { useEffect, useState } from "react";
import { api, type GatewayConfig } from "../api";

const POLICIES = [
  { value: "strip_for_non_anthropic_upstream", label: "非 Anthropic 上游时清理" },
  { value: "strip", label: "总是清理 billing headers" },
  { value: "canonicalize", label: "规范化缓存键" },
  { value: "pass_through", label: "透传" },
];

export function Sanitizer() {
  const [config, setConfig] = useState<GatewayConfig | null>(null);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    api.getConfig().then(setConfig).catch((e) => setMsg(String(e)));
  }, []);

  const save = async () => {
    if (!config) return;
    try {
      setConfig(await api.saveConfig(config));
      setMsg("Sanitizer settings saved.");
    } catch (e) {
      setMsg(String(e));
    }
  };

  const compat = config?.claude_code_compat ?? {};

  return (
    <div className="col page-wide">
      <div>
        <h1>清洗与缓存</h1>
        <p className="sub">Claude Code 可能注入 billing/cache headers；转发到非 Anthropic 上游前应清理，避免污染缓存和泄露身份信息。</p>
      </div>

      <div className="grid grid-2">
        <div className="card col">
          <h2>策略</h2>
          <div className="field">
            <label>billing_header_policy</label>
            <select
              value={compat.billing_header_policy ?? "strip_for_non_anthropic_upstream"}
              onChange={(e) => setConfig(config ? {
                ...config,
                claude_code_compat: { ...compat, billing_header_policy: e.target.value },
              } : config)}
            >
              {POLICIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </div>
          <label className="switch-line">
            <input
              type="checkbox"
              checked={compat.enabled !== false}
              onChange={(e) => setConfig(config ? { ...config, claude_code_compat: { ...compat, enabled: e.target.checked } } : config)}
            />
            Enable Claude Code compatibility
          </label>
          <label className="switch-line">
            <input
              type="checkbox"
              checked={compat.require_haiku_alias !== false}
              onChange={(e) => setConfig(config ? { ...config, claude_code_compat: { ...compat, require_haiku_alias: e.target.checked } } : config)}
            />
            Warn when Haiku aliases are missing
          </label>
          <button className="primary" onClick={save}>Save policy</button>
        </div>

        <div className="card col">
          <h2>清洗示例</h2>
          <div className="split-pre">
            <div>
              <div className="muted">Before</div>
              <pre>{`authorization: Bearer <gateway key>
x-anthropic-billing-header: cch=random-value
x-anthropic-billing-request: request-id
anthropic-version: 2023-06-01`}</pre>
            </div>
            <div>
              <div className="muted">After</div>
              <pre>{`authorization: Bearer <upstream key>
anthropic-version: 2023-06-01

# billing/cache identity headers removed`}</pre>
            </div>
          </div>
        </div>
      </div>

      {msg && <div className={`badge ${msg.includes("Error") ? "err" : "ok"}`}>{msg}</div>}
    </div>
  );
}
