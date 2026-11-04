import { useCallback, useEffect, useState } from "react";
import { Bell, Loader, RefreshCw, Save, Send, Trash2 } from "lucide-react";
import { api } from "../../api/client";
import type { PushBrowser, PushConfig, PushEventType, PushTestResult } from "../../api/types";
import { Button } from "../../components/ui/button";
import { Switch } from "../../components/ui/switch";
import { browserPushPermission, currentPushBrowserId, disableBrowserPush, enableBrowserPush, hasLocalPushSubscription } from "../../lib/pushNotifications";
import { formatShortDateTime } from "../../lib/format";
import { notify } from "../../lib/notify";
import styles from "../Settings.module.scss";
import systemStyles from "../System.module.scss";

const EVENTS: { type: PushEventType; label: string }[] = [
  { type: "health_check", label: "Project health check failed" },
  { type: "deploy_blocked", label: "Automatic deployment blocked" },
  { type: "deploy_unhealthy", label: "Deployment failed its health check" },
  { type: "rollback_failed", label: "Automatic rollback failed" },
  { type: "system_update_failed", label: "Stackport update failed" },
];

export default function BrowserPushSection({ onDelivery }: { onDelivery: () => void }) {
  const [saved, setSaved] = useState<PushConfig | null>(null);
  const [draft, setDraft] = useState<PushConfig | null>(null);
  const [browsers, setBrowsers] = useState<PushBrowser[]>([]);
  const [permission, setPermission] = useState(browserPushPermission);
  const [currentId, setCurrentId] = useState(currentPushBrowserId);
  const [localSubscription, setLocalSubscription] = useState(false);
  const [label, setLabel] = useState("This browser");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [test, setTest] = useState<PushTestResult | null>(null);

  const refreshBrowsers = useCallback(async () => {
    const rows = await api.listPushBrowsers();
    setBrowsers(rows);
    setCurrentId(currentPushBrowserId());
    setLocalSubscription(await hasLocalPushSubscription());
    setPermission(browserPushPermission());
    return rows;
  }, []);

  const load = useCallback(async () => {
    try {
      const [config, rows] = await Promise.all([api.getPushConfig(), refreshBrowsers()]);
      setSaved(config);
      setDraft(config);
      const current = rows.find((row) => row.id === currentPushBrowserId());
      if (current) setLabel(current.label);
      setError("");
    } catch (err) { setError(err instanceof Error ? err.message : "Could not load browser push settings"); }
  }, [refreshBrowsers]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const update = () => { setPermission(browserPushPermission()); void hasLocalPushSubscription().then(setLocalSubscription).catch(() => undefined); };
    window.addEventListener("focus", update);
    return () => window.removeEventListener("focus", update);
  }, []);

  const thisBrowser = browsers.find((browser) => browser.id === currentId);
  const registered = !!thisBrowser && localSubscription;
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
    catch (err) { notify.error(err, "Could not remove this browser"); }
    finally { setBusy(false); }
  }

  async function sendTest(id?: number) {
    setBusy(true);
    try {
      const result = await api.testPush(id);
      setTest(result);
      if (result.ok) notify.success("Test push sent. Check your device notifications.");
      else notify.error(null, "Some browsers could not receive the test. See the delivery results below.");
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
        <div className="field"><label htmlFor="push-browser-name">Browser name</label>
          <input id="push-browser-name" value={label} maxLength={100} disabled={busy} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Work laptop" />
        </div>
        <div className={styles.pushActions}>
          <Button size="sm" type="button" disabled={busy || permission === "unsupported" || permission === "denied" || !saved?.enabled || changed}
            onClick={() => void enable()}>{registered ? "Update this browser" : "Enable on this browser"}</Button>
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
              <small>Last successful push: {browser.lastSuccessAt ? formatShortDateTime(browser.lastSuccessAt) : "Never"}</small>
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
        <li key={result.id}>{result.label}: {result.ok ? "Sent" : result.error ?? "Delivery failed"}</li>)}</ul></div>}
    </div>}
  </section>;
}
