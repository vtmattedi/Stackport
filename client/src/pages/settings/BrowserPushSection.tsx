import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, Loader, RefreshCw, Save, Send, Trash2 } from "lucide-react";
import { api } from "../../api/client";
import type { PushBrowser, PushConfig, PushEventType, PushStatus, PushTestResult } from "../../api/types";
import { Button } from "../../components/ui/button";
import { Switch } from "../../components/ui/switch";
import { browserPushPermission, currentPushBrowserId, disableBrowserPush, enableBrowserPush, reconcileBrowserPush, type BrowserPushState } from "../../lib/pushNotifications";
import { formatShortDateTime } from "../../lib/format";
import { notify } from "../../lib/notify";
import styles from "../Settings.module.scss";
import systemStyles from "../System.module.scss";

const EVENTS: { type: PushEventType; label: string }[] = [
  { type: "health_check", label: "Project health check failed" },
  { type: "deploy_blocked", label: "Automatic deployment blocked" },
  { type: "deploy_unhealthy", label: "Deployment failed its health check" },
  { type: "rollback_failed", label: "Automatic rollback failed" },
  { type: "rollback_recovered", label: "Automatic rollback restored service" },
  { type: "system_update_failed", label: "Stackport update failed" },
  { type: "certificate_expiring", label: "A certificate is about to expire" },
  { type: "certificate_renewal_failed", label: "Certificate renewal failed" },
];

export default function BrowserPushSection({ onDelivery }: { onDelivery: () => void }) {
  const [saved, setSaved] = useState<PushConfig | null>(null);
  const [draft, setDraft] = useState<PushConfig | null>(null);
  const [browsers, setBrowsers] = useState<PushBrowser[]>([]);
  const [permission, setPermission] = useState(browserPushPermission);
  const [currentId, setCurrentId] = useState(currentPushBrowserId);
  const [browserState, setBrowserState] = useState<BrowserPushState>({ id: null, local: false, registered: false, keyMismatch: false, removalPending: false });
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const publicKey = useRef<string | null>(null);
  const [label, setLabel] = useState("This browser");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [test, setTest] = useState<PushTestResult | null>(null);

  const refreshBrowsers = useCallback(async () => {
    const [rows, queue] = await Promise.all([api.listPushBrowsers(), api.getPushStatus()]);
    const local = publicKey.current ? await reconcileBrowserPush(publicKey.current) : null;
    setBrowsers(rows);
    if (local) { setBrowserState(local); setCurrentId(local.id); }
    setStatus(queue);
    setStatusError("");
    setPermission(browserPushPermission());
    return rows;
  }, []);

  const load = useCallback(async () => {
    try {
      const config = await api.getPushConfig();
      publicKey.current = config.vapidPublicKey;
      const rows = await refreshBrowsers();
      setSaved(config);
      setDraft(config);
      const current = rows.find((row) => row.id === currentPushBrowserId());
      if (current) setLabel(current.label);
      setError("");
    } catch (err) { setError(err instanceof Error ? err.message : "Could not load browser push settings"); }
  }, [refreshBrowsers]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const update = () => { setPermission(browserPushPermission()); void refreshBrowsers().catch(() => setStatusError("Could not refresh browser status. Try Refresh browsers.")); };
    window.addEventListener("focus", update);
    return () => window.removeEventListener("focus", update);
  }, [refreshBrowsers]);
  useEffect(() => {
    const timer = setInterval(() => { void api.getPushStatus().then((value) => { setStatus(value); setStatusError(""); })
      .catch(() => setStatusError("Push worker status is unavailable. Refresh to retry.")); }, 5000);
    return () => clearInterval(timer);
  }, []);

  const thisBrowser = browsers.find((browser) => browser.id === currentId);
  const registered = !!thisBrowser && browserState.registered;
  const changed = JSON.stringify(draft) !== JSON.stringify(saved);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!draft) return;
    setBusy(true);
    try {
      const config = await api.updatePushConfig(draft);
      setSaved(config);
      setDraft(config);
      setError("");
      notify.success("Browser push settings saved.");
    } catch (err) { notify.error(err, "Could not save browser push settings"); }
    finally { setBusy(false); }
  }

  async function enable() {
    if (!saved) return;
    setBusy(true);
    try {
      // Keep this call before any other await: the browser prompt needs a click.
      await enableBrowserPush(saved.vapidPublicKey, label);
      await refreshBrowsers();
      notify.success("This browser is registered for push alerts.");
    } catch (err) { notify.error(err, "Could not enable browser push"); }
    finally { setPermission(browserPushPermission()); setBusy(false); }
  }

  async function remove(id: number) {
    setBusy(true);
    try { await disableBrowserPush(id); await refreshBrowsers(); notify.success("Browser removed."); }
    catch (err) { notify.error(err, "Could not remove this browser"); await refreshBrowsers().catch(() => undefined); }
    finally { setBusy(false); }
  }

  async function sendTest(id?: number) {
    setBusy(true);
    try {
      const result = await api.testPush(id);
      setTest(result);
      if (result.ok) notify.success("Accepted by push service. Device display is not guaranteed.");
      else notify.error(null, "Some push services rejected the test. See the attempt results below.");
      await refreshBrowsers();
    } catch (err) { notify.error(err, "Could not send a test push"); }
    finally { setBusy(false); onDelivery(); }
  }

  return <section className={systemStyles.systemPanel}>
    <div className={systemStyles.sectionTitle}>
      <Bell size={14} /> Browser push
      <span className={systemStyles.titleMeta}>{saved?.enabled ? "enabled" : "disabled"}</span>
      <div className={systemStyles.titleActions}>
        <Button size="xs" variant="outline" type="button" disabled={busy} onClick={() => void refreshBrowsers().catch((err) => notify.error(err, "Could not refresh browsers"))}>
          <RefreshCw size={12} /> Refresh browsers
        </Button>
      </div>
    </div>
    {error && <div role="alert"><p>{error}</p><Button variant="outline" size="xs" onClick={() => void load()}>Retry</Button></div>}
    {!draft ? !error && <p className="muted-text">Loading browser push settings…</p> : <div className={styles.settingsForm}>
      <p className="muted-text">Receive important alerts on your devices, even when Stackport is closed. Email alerts are configured separately below.</p>
      {statusError && <p role="alert">{statusError}</p>}
      {(status?.identityError || saved?.identityError) && <p role="alert" style={{ color: "var(--danger)" }}>{status?.identityError ?? saved?.identityError}</p>}
      {status && <div role="status">
        <p className="mb-1 text-[13px]">Pending: {status.pending} · Retrying: {status.retrying} · In progress: {status.leased} · Permanent failures (24 h): {status.permanentFailures24h}</p>
        <p className="hint">Last provider acceptance: {status.lastSuccessfulAcceptanceAt ? formatShortDateTime(status.lastSuccessfulAcceptanceAt) : "Never"}.
          {status.oldestPendingAgeSeconds !== null && ` Oldest queued alert: ${status.oldestPendingAgeSeconds}s.`}
          {status.lastWorkerPollAt && ` Worker last checked: ${formatShortDateTime(status.lastWorkerPollAt)}.`}</p>
        {status.permanentFailures24h > 0 && <p role="alert">Some push attempts need attention. Check the delivery log for the error code, verify the contact address and test the affected browser.</p>}
        {status.queueWarning && <p role="alert">{status.queueWarning}</p>}
      </div>}
      {saved?.enabled && browsers.length === 0 && <p role="alert">Browser push is enabled, but no browsers are registered. Register a browser to receive future alerts.</p>}
      <form className={styles.settingsForm} onSubmit={(e) => void save(e)}>
        <label className={styles.switchField}>
          <Switch checked={draft.enabled} disabled={busy} onCheckedChange={(enabled) => setDraft({ ...draft, enabled })} />
          <span><span>Enable browser push</span><span>Allow alerts to all registered browsers.</span></span>
        </label>
        <div className="field">
          <label htmlFor="push-contact">Contact email or HTTPS URL</label>
          <input id="push-contact" type="text" maxLength={300} value={draft.subject} disabled={busy}
            onChange={(e) => setDraft({ ...draft, subject: e.target.value })} placeholder="you@example.com" required={draft.enabled} />
          <span className="hint">A contact address for browser push services if delivery has a problem.</span>
        </div>
        <fieldset className={styles.pushEvents} disabled={busy}>
          <legend>Send push alerts when</legend>
          {EVENTS.map(({ type, label: eventLabel }) => <label key={type} className={styles.switchField}>
            <Switch checked={draft.events[type]} onCheckedChange={(enabled) => setDraft({ ...draft, events: { ...draft.events, [type]: enabled } })} />
            <span>{eventLabel}</span>
          </label>)}
        </fieldset>
        <div><Button size="sm" variant="outline" type="submit" disabled={busy || !changed}>
          {busy ? <Loader size={14} className="spin" /> : <Save size={14} />} Save push settings
        </Button></div>
      </form>
      <div className={styles.pushBrowser}>
        <strong>This browser</strong>
        <p className="muted-text" role="status">
          {permission === "unsupported" ? "Browser push is unavailable here. Use HTTPS and a browser with Web Push support. On iPhone or iPad, add Stackport to the Home Screen first."
            : permission === "denied" ? "Notifications are blocked. Allow notifications in your browser's site settings to enable this browser."
              : `Permission: ${permission === "default" ? "not requested" : "granted"}. This browser: ${registered ? "registered" : "not registered"}.`}
        </p>
        {browserState.keyMismatch && <p role="alert">This browser uses a different signing identity. Click Replace browser subscription to reconnect it; no permission prompt will appear unless you explicitly enable notifications.</p>}
        {browserState.local && !registered && !browserState.keyMismatch && !browserState.removalPending && <p role="status">This browser has a local subscription, but it is missing from Stackport. Click Restore browser registration.</p>}
        {browserState.removalPending && <p role="alert">Server alerts are disabled for this browser. Finish disabling it below to remove the local subscription.</p>}
        <div className="field"><label htmlFor="push-browser-name">Browser name</label>
          <input id="push-browser-name" value={label} maxLength={100} disabled={busy} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Work laptop" />
        </div>
        <div className={styles.pushActions}>
          <Button size="sm" type="button" disabled={busy || browserState.removalPending || !!status?.identityError || permission === "unsupported" || permission === "denied" || !saved?.enabled || changed}
            onClick={() => void enable()}>{browserState.keyMismatch ? "Replace browser subscription" : registered ? "Update this browser" : browserState.local ? "Restore browser registration" : "Enable on this browser"}</Button>
          {browserState.removalPending && currentId && <Button size="sm" variant="outline" disabled={busy} onClick={() => void remove(currentId)}>Finish disabling this browser</Button>}
          {thisBrowser && <Button size="sm" type="button" variant="outline" disabled={busy} onClick={() => void remove(thisBrowser.id)}>Disable this browser</Button>}
          <Button size="sm" type="button" variant="outline" disabled={busy || !saved?.enabled || changed || !registered}
            onClick={() => void sendTest(currentId ?? undefined)}><Send size={14} /> Send test to this browser</Button>
        </div>
        {(!saved?.enabled || changed) && <p className="hint">Enable and save push settings before registering a browser or sending a test.</p>}
      </div>
      <div>
        <div className={styles.pushActions}><strong>Registered browsers</strong>
          <Button size="xs" variant="outline" disabled={busy || !saved?.enabled || changed || !browsers.length} onClick={() => void sendTest()}>Test all browsers</Button>
        </div>
        {!browsers.length ? <p className="muted-text">No browsers registered yet.</p> : <ul className={styles.pushBrowsers}>
          {browsers.map((browser) => <li key={browser.id}>
            <div><strong>{browser.label}{browser.id === currentId ? " · This browser" : ""}</strong>
              <small>Last provider acceptance: {browser.lastSuccessAt ? formatShortDateTime(browser.lastSuccessAt) : "Never"}</small>
              {browser.lastFailureAt && <small>Last failed attempt: {formatShortDateTime(browser.lastFailureAt)}</small>}
            </div>
            <div className={styles.pushActions}>
              <Button size="xs" variant="outline" disabled={busy || !saved?.enabled || changed} onClick={() => void sendTest(browser.id)}><Send size={12} /> Test</Button>
              <Button size="xs" variant="outline" disabled={busy} onClick={() => void remove(browser.id)}><Trash2 size={12} /> Remove</Button>
            </div>
          </li>)}
        </ul>}
      </div>
      {test && <div role="status"><strong>Last test delivery</strong><ul>{test.results.map((result) =>
        <li key={result.id}>{result.label}: {result.ok ? "Accepted by push service" : result.error ?? "Submission failed"}</li>)}</ul></div>}
    </div>}
  </section>;
}
