import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { Layout, type Tab } from "./components/Layout";
import { LockScreen } from "./components/LockScreen";
import { Overview } from "./pages/Overview";
import { Providers } from "./pages/Providers";
import { Aliases } from "./pages/Aliases";
import { Traces } from "./pages/Traces";
import { hasKey, onAuthChange } from "./auth";
import { AuthError } from "./api";

function App() {
  const [tab, setTab] = useState<Tab>("overview");
  // locked = no stored key. Re-check on auth changes (401 forgets the key).
  const [locked, setLocked] = useState(!hasKey());
  // Surface a concise error on the lock screen when a 401 forced the lock.
  const [lockError, setLockError] = useState("");

  useEffect(() => {
    return onAuthChange(() => {
      setLocked(!hasKey());
    });
  }, []);

  // Global guard: if any page throws an AuthError, surface it on the lock screen.
  useEffect(() => {
    const onErr = (e: ErrorEvent) => {
      if (e.error instanceof AuthError) {
        setLockError("Gateway key was rejected. Please re-enter it.");
        setLocked(true);
      }
    };
    window.addEventListener("error", onErr);
    return () => window.removeEventListener("error", onErr);
  }, []);

  if (locked) {
    return <LockScreen initialError={lockError} />;
  }

  return (
    <Layout tab={tab} setTab={setTab}>
      {tab === "overview" && <Overview />}
      {tab === "providers" && <Providers />}
      {tab === "aliases" && <Aliases />}
      {tab === "traces" && <Traces />}
    </Layout>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
