import { useEffect, useState } from "react";
import { api, type GatewayConfig, type ProfileRow } from "../api";

const ROLES: Array<{ key: keyof ProfileRow; label: string; desc: string }> = [
  { key: "main_model", label: "主模型", desc: "通用对话、代码、计划" },
  { key: "fast_tool_model", label: "快速 / 工具", desc: "Claude Code Haiku 工具路径" },
  { key: "large_model", label: "大型 / 推理", desc: "长上下文和复杂推理" },
  { key: "verifier_model", label: "校验", desc: "审查、复核、二次确认" },
  { key: "vision_model", label: "视觉", desc: "图像转文字证据" },
  { key: "fallback_model", label: "兜底", desc: "上游失败时降级" },
];

const EMPTY: ProfileRow = { id: "default", name: "默认方案" };

export function Profiles() {
  const [config, setConfig] = useState<GatewayConfig | null>(null);
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [form, setForm] = useState<ProfileRow>(EMPTY);
  const [msg, setMsg] = useState("");

  const load = async () => {
    const [cfg, rows] = await Promise.all([api.getConfig(), api.listProfiles()]);
    setConfig(cfg);
    setProfiles(rows.profiles);
    const def = cfg.runtime?.default_profile ?? rows.profiles[0]?.id ?? "default";
    setForm(rows.profiles.find((p) => p.id === def) ?? { ...EMPTY, id: def });
  };

  useEffect(() => { load().catch((e) => setMsg(String(e))); }, []);

  const save = async () => {
    setMsg("");
    if (!form.id || !form.name) {
      setMsg("profile id and name required");
      return;
    }
    try {
      await api.saveProfile(form);
      if (config) {
        await api.saveConfig({
          ...config,
          runtime: { ...(config.runtime ?? {}), default_profile: form.id },
        });
      }
      await load();
      setMsg("Profile saved.");
    } catch (e) {
      setMsg(String(e));
    }
  };

  const remove = async (id: string) => {
    await api.deleteProfile(id);
    await load();
  };

  const models = Array.from(new Set([
    ...profiles.flatMap((p) => ROLES.map((r) => String(p[r.key] ?? "")).filter(Boolean)),
    ...(config?.providers ?? []).flatMap((p) => [p.default_model ?? "", ...(p.capabilities?.models ?? [])]).filter(Boolean),
  ])).sort();

  return (
    <div className="col page-wide">
      <div>
        <h1>模型方案</h1>
        <p className="sub">把 Claude Code 的不同角色映射到真实上游模型。保存后 aliases 可以按这些模型名路由。</p>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "280px 1fr" }}>
        <div className="card col">
          <h2>方案列表</h2>
          {profiles.length === 0 && <div className="muted">No profiles yet.</div>}
          {profiles.map((p) => (
            <button key={p.id} className={`profile-row ${form.id === p.id ? "active" : ""}`} onClick={() => setForm(p)}>
              <span>{p.name}</span>
              <span className="mono muted">{p.id}</span>
            </button>
          ))}
          <button onClick={() => setForm({ id: `profile-${profiles.length + 1}`, name: "新方案" })}>New profile</button>
        </div>

        <div className="card col">
          <h2>{form.id ? `编辑 ${form.id}` : "新建方案"}</h2>
          <div className="row">
            <div className="field grow"><label>id</label><input className="mono" value={form.id ?? ""} onChange={(e) => setForm({ ...form, id: e.target.value })} /></div>
            <div className="field grow"><label>name</label><input value={form.name ?? ""} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          </div>

          <div className="role-grid">
            {ROLES.map((role) => (
              <div key={role.key} className="role-card">
                <div>
                  <div className="role-title">{role.label}</div>
                  <div className="muted">{role.desc}</div>
                </div>
                <input
                  className="mono"
                  list="known-models"
                  value={String(form[role.key] ?? "")}
                  onChange={(e) => setForm({ ...form, [role.key]: e.target.value })}
                  placeholder="provider/model or upstream model id"
                />
              </div>
            ))}
          </div>
          <datalist id="known-models">{models.map((m) => <option key={m} value={m} />)}</datalist>

          <div className="row">
            <button className="primary" onClick={save}>Save and set default</button>
            {profiles.some((p) => p.id === form.id) && <button onClick={() => remove(form.id)}>Delete</button>}
          </div>
          {msg && <div className={`badge ${msg.includes("Error") || msg.includes("required") ? "err" : "ok"}`}>{msg}</div>}
        </div>
      </div>
    </div>
  );
}
