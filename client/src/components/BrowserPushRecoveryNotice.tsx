import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { browserPushRecoveryNeeded } from "../lib/pushNotifications";
import styles from "./BrowserPushRecoveryNotice.module.scss";

export function BrowserPushRecoveryNotice() {
  const [needsRepair, setNeedsRepair] = useState(false);

  useEffect(() => {
    let disposed = false;
    let checking = false;
    const check = async () => {
      if (checking || document.visibilityState === "hidden") return;
      checking = true;
      try {
        const needed = await browserPushRecoveryNeeded();
        if (!disposed) setNeedsRepair(needed);
      } catch { /* A failed lookup is not evidence that registration needs repair. */ }
      finally { checking = false; }
    };
    const refresh = () => { void check(); };
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = window.setInterval(refresh, 60_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  if (!needsRepair) return null;
  return <aside className={styles.notice} role="status">
    <span>Browser alerts need attention on this device.</span>
    <Link to="/settings/notifications">Review notification settings</Link>
  </aside>;
}
