import { useState } from "react";
import { setKey } from "../auth";

export function LockScreen({ initialError = "" }: { initialError?: string }) {
  const [key, setKeyInput] = useState("");
  const [remember, setRemember] = useState(false);
  const [err, setErr] = useState(initialError);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = key.trim();
    if (!trimmed) {
      setErr("Enter the gateway key.");
      return;
    }
    setKey(trimmed, remember);
    // onAuthChange in App will re-render past the lock; no manual nav needed.
  };

  return (
    <div className="lock-wrap">
      <form className="lock-card" onSubmit={submit}>
        <div className="brand" style={{ justifyContent: "center", padding: "0 0 8px" }}>
          <span className="dot" />
          <span>SuperDeepSeek</span>
        </div>
        <h1>Dashboard locked</h1>
        <p className="sub">Enter the gateway admin key to manage providers, aliases, and traces.</p>
        <input
          type="password"
          placeholder="gateway key"
          value={key}
          onChange={(e) => setKeyInput(e.target.value)}
          autoFocus
        />
        <label className="row" style={{ justifyContent: "flex-start", margin: "6px 0" }}>
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            style={{ width: "auto" }}
          />
          <span className="muted">Remember on this device (localStorage)</span>
        </label>
        {err && <div className="badge err">{err}</div>}
        <button className="primary" type="submit">Unlock</button>
        <p className="muted" style={{ fontSize: 11, marginTop: 8 }}>
          The key is sent only as an Authorization header to this Worker's own /api/* endpoints. By default it lives in
          sessionStorage and is cleared when the tab closes.
        </p>
      </form>
    </div>
  );
}
