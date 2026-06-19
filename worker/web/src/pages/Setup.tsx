import { useEffect, useMemo, useState } from "react";
import { api, type AliasRow, type ProviderRow } from "../api";

const QUICK_ALIASES: Array<Partial<AliasRow>> = [
  { alias: "claude-3-5-haiku-latest", role: "fast_tool", strategy: "failover" },
  { alias: "claude-3-5-haiku-20241022", role: "fast_tool", strategy: "failover" },
  { alias: "claude-sonnet-4-5", role: "main", strategy: "failover" },
  { alias: "claude-3-7-sonnet-latest", role: "main", strategy: "failover" },
  { alias: "claude-opus-4-1", role: "large", strategy: "failover" },
];

const EMPTY_PROVIDER: Partial<ProviderRow> = {
  id: "siliconflow",
  name: "SiliconFlow",
  protocol: "openai",
  base_url: "https://api.siliconflow.cn/v1",
  api_key: "",
  default_model: "zai-org/GLM-5.2",
};

export function Setup({ goto }: { goto: (tab: "providers" | "profiles" | "claude") => void }) {
  const [provider, setProvider] = useState<Partial<ProviderRow>>(EMPTY_PROVIDER);
  const [aliasModel, setAliasModel] = useState("zai-org/GLM-5.2");
  const [providerId, setProviderId] = useState("siliconflow");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");

  useEffect(() => {
    setBaseUrl(window.location.origin);
  }, []);

  const env = useMemo(() => [
    `export ANTHROPIC_BASE_URL="${baseUrl}"`,
    `export ANTHROPIC_API_KEY="<your superglm gateway key>"`,
    "claude",
    "",
    `export OPENAI_BASE_URL="${baseUrl}/openai/v1"`,
    `export OPENAI_API_KEY="<your superglm gateway key>"`,
  ].join("\n"), [baseUrl]);

  const saveProvider = async () => {
    setMsg("");
    if (!provider.id || !provider.name || !provider.base_url) {
      setMsg("provider id / name / base_url required");
      return;
    }
    setBusy(true);
    try {
      await api.saveProvider(provider);
      setProviderId(provider.id);
      setMsg("Provider saved.");
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  const createClaudeAliases = async () => {
    setMsg("");
    setBusy(true);
    try {
      for (const alias of QUICK_ALIASES) {
        if (!alias.alias || !alias.role) continue;
        await api.saveAlias({
          alias: alias.alias,
          id: alias.alias,
          role: alias.role,
          strategy: alias.strategy ?? "failover",
          target_model: aliasModel,
          provider_id: providerId || null,
          enabled: true,
        });
      }
      setMsg("Claude Code aliases saved.");
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="col page-wide">
      <div>
        <h1>配置向导</h1>
        <p className="sub">先配置上游 provider，再生成 Claude Code 常用别名，最后复制客户端环境变量。</p>
      </div>

      <div className="steps-strip">
        {["1 上游服务", "2 Claude aliases", "3 客户端环境变量", "4 追踪验证"].map((s) => <span key={s}>{s}</span>)}
      </div>

      <div className="grid grid-2">
        <div className="card col">
          <h2>1 · 添加上游服务</h2>
          <div className="row">
            <div className="field grow"><label>id</label><input value={provider.id ?? ""} onChange={(e) => setProvider({ ...provider, id: e.target.value })} /></div>
            <div className="field grow"><label>name</label><input value={provider.name ?? ""} onChange={(e) => setProvider({ ...provider, name: e.target.value })} /></div>
          </div>
          <div className="field"><label>base_url</label><input className="mono" value={provider.base_url ?? ""} onChange={(e) => setProvider({ ...provider, base_url: e.target.value })} /></div>
          <div className="row">
            <div className="field"><label>protocol</label>
              <select value={provider.protocol ?? "openai"} onChange={(e) => setProvider({ ...provider, protocol: e.target.value })}>
                <option value="openai">openai</option>
                <option value="anthropic">anthropic</option>
              </select>
            </div>
            <div className="field grow"><label>default_model</label><input className="mono" value={provider.default_model ?? ""} onChange={(e) => {
              setProvider({ ...provider, default_model: e.target.value });
              setAliasModel(e.target.value);
            }} /></div>
          </div>
          <div className="field"><label>api_key</label><input type="password" value={provider.api_key ?? ""} onChange={(e) => setProvider({ ...provider, api_key: e.target.value })} placeholder="leave blank when editing an existing provider" /></div>
          <div className="row">
            <button className="primary" disabled={busy} onClick={saveProvider}>Save provider</button>
            <button onClick={() => goto("providers")}>Open providers</button>
          </div>
        </div>

        <div className="card col">
          <h2>2 · 生成 Claude Code aliases</h2>
          <div className="field"><label>provider pin</label><input className="mono" value={providerId} onChange={(e) => setProviderId(e.target.value)} /></div>
          <div className="field"><label>target_model</label><input className="mono" value={aliasModel} onChange={(e) => setAliasModel(e.target.value)} /></div>
          <div className="pre">{QUICK_ALIASES.map((a) => `${a.alias} -> ${aliasModel}`).join("\n")}</div>
          <div className="row">
            <button className="primary" disabled={busy} onClick={createClaudeAliases}>Create aliases</button>
            <button onClick={() => goto("claude")}>Open Claude Code</button>
          </div>
        </div>
      </div>

      <div className="card col">
        <h2>3 · 客户端环境变量</h2>
        <div className="pre">{env}</div>
      </div>

      {msg && <div className={`badge ${msg.includes("Error") || msg.includes("required") ? "err" : "ok"}`}>{msg}</div>}
    </div>
  );
}
