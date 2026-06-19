import { useEffect, useState } from "react";
import { api, type ProviderRow } from "../api";

const EMPTY: Partial<ProviderRow> = { id: "", name: "", protocol: "openai", base_url: "", api_key: "", default_model: "" };

export function Providers() {
  const [rows, setRows] = useState<ProviderRow[]>([]);
  const [form, setForm] = useState<Partial<ProviderRow>>(EMPTY);
  const [msg, setMsg] = useState("");
  const [testResult, setTestResult] = useState<Record<string, unknown> | null>(null);

  const load = () => api.listProviders().then((r) => setRows(r.providers)).catch((e) => setMsg(String(e)));
  useEffect(() => { load(); }, []);

  const save = async () => {
    setMsg("");
    if (!form.id || !form.base_url) { setMsg("id and base_url required"); return; }
    try {
      await api.saveProvider(form);
      setForm(EMPTY);
      await load();
    } catch (e) { setMsg(String(e)); }
  };

  const remove = async (id: string) => {
    await api.deleteProvider(id);
    await load();
  };

  const test = async (p: ProviderRow) => {
    setTestResult(null);
    setTestResult(await api.testConnection({ provider_id: p.id }));
  };

  return (
    <div className="col">
      <h1>Providers</h1>
      <p className="sub">Upstream OpenAI / Anthropic-compatible endpoints used for routing.</p>

      <div className="card col">
        <h2>{form.id ? `Edit ${form.id}` : "Add provider"}</h2>
        <div className="row">
          <div className="field grow"><label>id</label><input value={form.id ?? ""} onChange={(e) => setForm({ ...form, id: e.target.value })} placeholder="deepseek" /></div>
          <div className="field grow"><label>name</label><input value={form.name ?? ""} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="DeepSeek" /></div>
          <div className="field"><label>protocol</label>
            <select value={form.protocol ?? "openai"} onChange={(e) => setForm({ ...form, protocol: e.target.value })}>
              <option value="openai">openai</option>
              <option value="anthropic">anthropic</option>
            </select>
          </div>
        </div>
        <div className="row">
          <div className="field grow"><label>base_url</label><input value={form.base_url ?? ""} onChange={(e) => setForm({ ...form, base_url: e.target.value })} placeholder="https://api.deepseek.com/v1" /></div>
          <div className="field grow"><label>api_key</label><input value={form.api_key ?? ""} onChange={(e) => setForm({ ...form, api_key: e.target.value })} placeholder="leave blank to keep existing key" /></div>
        </div>
        <div className="row">
          <div className="field grow"><label>default_model</label><input value={form.default_model ?? ""} onChange={(e) => setForm({ ...form, default_model: e.target.value })} placeholder="deepseek-chat" /></div>
          <button className="primary" onClick={save}>Save</button>
        </div>
        {msg && <div className="badge err">{msg}</div>}
      </div>

      <div className="card col">
        <h2>Saved providers</h2>
        <table>
          <thead><tr><th>id</th><th>name</th><th>protocol</th><th>base_url</th><th>key</th><th></th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={6} className="muted">No providers yet.</td></tr>}
            {rows.map((p) => (
              <tr key={p.id}>
                <td className="mono">{p.id}</td>
                <td>{p.name}</td>
                <td className="mono">{p.protocol}</td>
                <td className="mono">{p.base_url}</td>
                <td className="mono">{p.api_key ? "****" : "—"}</td>
                <td>
                  <div className="row right">
                    <button onClick={() => test(p)}>Test</button>
                    <button onClick={() => setForm({ ...p, api_key: "" })}>Edit</button>
                    <button onClick={() => remove(p.id)}>Delete</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {testResult && (
          <div className="pre">{JSON.stringify(testResult, null, 2)}</div>
        )}
      </div>
    </div>
  );
}
