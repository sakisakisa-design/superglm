import { useEffect, useState } from "react";
import { api, type AliasRow, type ProviderRow } from "../api";

const EMPTY: Partial<AliasRow> = { alias: "", target_model: "", provider_id: "", strategy: "round_robin", role: "main" };

export function Aliases() {
  const [rows, setRows] = useState<AliasRow[]>([]);
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [form, setForm] = useState<Partial<AliasRow>>(EMPTY);
  const [msg, setMsg] = useState("");

  const load = async () => {
    const [a, p] = await Promise.all([api.listAliases(), api.listProviders()]);
    setRows(a.aliases);
    setProviders(p.providers);
  };
  useEffect(() => { load().catch((e) => setMsg(String(e))); }, []);

  const save = async () => {
    setMsg("");
    if (!form.alias || !form.target_model) { setMsg("alias and target_model required"); return; }
    try {
      await api.saveAlias(form);
      setForm(EMPTY);
      await load();
    } catch (e) { setMsg(String(e)); }
  };

  const remove = async (alias: string) => {
    await api.deleteAlias(alias);
    await load();
  };

  return (
    <div className="col">
      <h1>Aliases</h1>
      <p className="sub">Public model names exposed to clients, mapped to real upstream models. Supports <code>*</code> wildcards.</p>

      <div className="card col">
        <h2>{form.alias ? `Edit ${form.alias}` : "Add alias"}</h2>
        <div className="row">
          <div className="field grow"><label>alias</label><input value={form.alias ?? ""} onChange={(e) => setForm({ ...form, alias: e.target.value })} placeholder="claude-3-5-haiku-latest" /></div>
          <div className="field grow"><label>target_model</label><input value={form.target_model ?? ""} onChange={(e) => setForm({ ...form, target_model: e.target.value })} placeholder="deepseek-chat" /></div>
        </div>
        <div className="row">
          <div className="field"><label>provider (pin)</label>
            <select value={form.provider_id ?? ""} onChange={(e) => setForm({ ...form, provider_id: e.target.value || null })}>
              <option value="">any</option>
              {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="field"><label>strategy</label>
            <select value={form.strategy ?? "round_robin"} onChange={(e) => setForm({ ...form, strategy: e.target.value })}>
              <option value="round_robin">round_robin</option>
              <option value="weighted">weighted</option>
              <option value="failover">failover</option>
            </select>
          </div>
          <div className="field"><label>role</label>
            <select value={form.role ?? "main"} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {["main", "fast_tool", "large", "verifier", "vision"].map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <button className="primary" onClick={save}>Save</button>
        </div>
        {msg && <div className="badge err">{msg}</div>}
      </div>

      <div className="card col">
        <h2>Saved aliases</h2>
        <table>
          <thead><tr><th>alias</th><th>target_model</th><th>provider</th><th>strategy</th><th>role</th><th></th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={6} className="muted">No aliases yet.</td></tr>}
            {rows.map((a) => (
              <tr key={a.id}>
                <td className="mono">{a.alias}</td>
                <td className="mono">{a.target_model}</td>
                <td className="mono">{a.provider_id ?? "any"}</td>
                <td className="mono">{a.strategy}</td>
                <td className="mono">{a.role ?? "main"}</td>
                <td><div className="row right"><button onClick={() => setForm(a)}>Edit</button><button onClick={() => remove(a.alias)}>Delete</button></div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
