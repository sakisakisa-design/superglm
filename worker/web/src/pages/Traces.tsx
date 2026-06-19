import { useEffect, useState } from "react";
import { api, type TraceRow } from "../api";

export function Traces() {
  const [rows, setRows] = useState<TraceRow[]>([]);
  const [selected, setSelected] = useState<TraceRow | null>(null);
  const [err, setErr] = useState("");

  const load = () => api.listTraces(100).then((r) => setRows(r.traces)).catch((e) => setErr(String(e)));
  useEffect(() => { load(); }, []);

  const open = async (id: string) => {
    try { setSelected(await api.getTrace(id)); } catch (e) { setErr(String(e)); }
  };

  return (
    <div className="col">
      <h1>Traces</h1>
      <p className="sub">Per-request observability for every gateway call.</p>
      {err && <div className="badge err">{err}</div>}

      <div className="grid grid-2">
        <div className="card col">
          <h2>Recent</h2>
          <table>
            <thead><tr><th>trace</th><th>model in</th><th>upstream</th><th>status</th><th>ms</th></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={5} className="muted">No traces yet.</td></tr>}
              {rows.map((t) => (
                <tr key={t.trace_id} onClick={() => open(t.trace_id)} style={{ cursor: "pointer" }}>
                  <td className="mono">{t.trace_id.slice(0, 14)}</td>
                  <td className="mono">{t.incoming_model ?? "—"}</td>
                  <td className="mono">{t.upstream_model ?? "—"}</td>
                  <td><span className={`badge ${t.status === "success" ? "ok" : "err"}`}>{t.status}</span></td>
                  <td className="mono">{t.latency_ms ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card col">
          <h2>{selected ? selected.trace_id : "Detail"}</h2>
          {!selected && <div className="muted">Select a trace to inspect.</div>}
          {selected && (
            <div className="col">
              <div className="row">
                <span className="badge neutral">{selected.method ?? "POST"} {selected.path}</span>
                <span className="badge neutral">{selected.upstream_provider_id ?? "—"}</span>
                <span className={`badge ${selected.status === "success" ? "ok" : "err"}`}>{selected.status}</span>
              </div>
              {selected.steps && selected.steps.length > 0 && (
                <>
                  <h2>Steps</h2>
                  <div className="pre">{JSON.stringify(selected.steps, null, 2)}</div>
                </>
              )}
              <h2>Request</h2>
              <div className="pre">{JSON.stringify(selected.request ?? {}, null, 2)}</div>
              <h2>Response</h2>
              <div className="pre">{JSON.stringify(selected.response ?? {}, null, 2)}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
