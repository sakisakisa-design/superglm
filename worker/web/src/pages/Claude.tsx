import { useEffect, useMemo, useState } from "react";
import { api, type AliasRow } from "../api";

const COMMON = [
  { alias: "claude-3-5-haiku-latest", role: "fast_tool" },
  { alias: "claude-3-5-haiku-20241022", role: "fast_tool" },
  { alias: "claude-3-7-sonnet-latest", role: "main" },
  { alias: "claude-sonnet-4-5", role: "main" },
  { alias: "claude-opus-4-1", role: "large" },
];

export function Claude() {
  const [aliases, setAliases] = useState<AliasRow[]>([]);
  const [target, setTarget] = useState("zai-org/GLM-5.2");
  const [provider, setProvider] = useState("");
  const [smoke, setSmoke] = useState<Record<string, unknown> | null>(null);
  const [msg, setMsg] = useState("");
  const baseUrl = window.location.origin;

  const load = async () => {
    const rows = await api.listAliases();
    setAliases(rows.aliases);
  };
  useEffect(() => { load().catch((e) => setMsg(String(e))); }, []);

  const checks = useMemo(() => {
    const enabled = aliases.filter((a) => a.enabled !== false);
    return [
      { label: "Haiku alias", ok: enabled.some((a) => a.alias.includes("haiku")) },
      { label: "Sonnet alias", ok: enabled.some((a) => a.alias.includes("sonnet")) },
      { label: "Opus alias", ok: enabled.some((a) => a.alias.includes("opus")) },
      { label: "OpenAI-compatible target model", ok: enabled.some((a) => Boolean(a.target_model)) },
    ];
  }, [aliases]);

  const env = [
    `export ANTHROPIC_BASE_URL="${baseUrl}"`,
    `export ANTHROPIC_API_KEY="<your superglm gateway key>"`,
    "claude",
  ].join("\n");

  const createCommon = async () => {
    setMsg("");
    try {
      for (const item of COMMON) {
        await api.saveAlias({
          id: item.alias,
          alias: item.alias,
          target_model: target,
          provider_id: provider || null,
          strategy: "failover",
          role: item.role,
          enabled: true,
        });
      }
      await load();
      setMsg("Claude aliases saved.");
    } catch (e) {
      setMsg(String(e));
    }
  };

  const runSmoke = async () => {
    try {
      setSmoke(await api.claudeSmoke());
    } catch (e) {
      setMsg(String(e));
    }
  };

  return (
    <div className="col page-wide">
      <div>
        <h1>Claude Code 兼容</h1>
        <p className="sub">把 Claude 风格模型名映射到你的 GLM / OpenAI-compatible 上游；Claude Code 只需要改 base URL 和 gateway key。</p>
      </div>

      <div className="grid grid-2">
        <div className="card col">
          <h2>兼容性检查</h2>
          {checks.map((c) => (
            <div key={c.label} className="check-row">
              <span className={`badge ${c.ok ? "ok" : "warn"}`}>{c.ok ? "OK" : "Missing"}</span>
              <span>{c.label}</span>
            </div>
          ))}
          <button className="primary" onClick={runSmoke}>Run smoke helper</button>
          {smoke && <div className="pre">{JSON.stringify(smoke, null, 2)}</div>}
        </div>

        <div className="card col">
          <h2>环境变量</h2>
          <div className="pre">{env}</div>
          <button onClick={() => navigator.clipboard?.writeText(env)}>Copy env</button>
        </div>
      </div>

      <div className="card col">
        <h2>一键补齐常用 Claude aliases</h2>
        <div className="row">
          <div className="field grow"><label>target_model</label><input className="mono" value={target} onChange={(e) => setTarget(e.target.value)} /></div>
          <div className="field grow"><label>provider_id (optional)</label><input className="mono" value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="siliconflow" /></div>
          <button className="primary" onClick={createCommon}>Create / update</button>
        </div>
      </div>

      <div className="card col">
        <h2>当前 alias 表</h2>
        <table>
          <thead><tr><th>alias</th><th>role</th><th>target_model</th><th>provider</th><th>strategy</th></tr></thead>
          <tbody>
            {aliases.map((a) => (
              <tr key={a.id}>
                <td className="mono">{a.alias}</td>
                <td>{a.role ?? "main"}</td>
                <td className="mono">{a.target_model}</td>
                <td className="mono">{a.provider_id ?? "any"}</td>
                <td className="mono">{a.strategy}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {msg && <div className={`badge ${msg.includes("Error") ? "err" : "ok"}`}>{msg}</div>}
    </div>
  );
}
