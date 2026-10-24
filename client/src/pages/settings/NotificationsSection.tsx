import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Bell, Check, Loader, Send, AlertCircle } from "lucide-react";
import { AppSelect } from "../../components/AppSelect";
import { ApiKeySelect } from "../../components/ApiKeySelect";
import { Switch } from "../../components/ui/switch";
import { api, ApiError } from "../../api/client";
import type { NotificationConfig, NotificationLogEntry, Credential } from "../../api/types";
import { formatShortDateTime } from "../../lib/format";
import styles from "../Settings.module.scss";

/** Email alerts for project health, with a test send and the recent email log. */
export default function NotificationsSection() {
  const [apiKeyCredentials, setApiKeyCredentials] = useState<Credential[]>([]);
  const [notifConfig, setNotifConfig] = useState<NotificationConfig | null>(null);
  const [notifEnabled, setNotifEnabled] = useState(false);
  const [notifProvider, setNotifProvider] = useState<NotificationConfig["provider"]>("resend");
  const [notifCredentialId, setNotifCredentialId] = useState<number | null>(null);
  const [notifFrom, setNotifFrom] = useState("");
  const [notifTo, setNotifTo] = useState("");
  const [savingNotif, setSavingNotif] = useState(false);
  const [testingNotif, setTestingNotif] = useState(false);
  const [notifError, setNotifError] = useState("");
  const [notifSuccess, setNotifSuccess] = useState("");
  const [notifLogs, setNotifLogs] = useState<NotificationLogEntry[]>([]);

  useEffect(() => {
    api.listCredentials().then((creds) => {
      setApiKeyCredentials(creds.filter((c) => c.type === "api_key"));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    api.getNotificationConfig().then((cfg) => {
      setNotifConfig(cfg);
      setNotifEnabled(cfg.enabled);
      setNotifProvider(cfg.provider);
      setNotifCredentialId(cfg.credentialId);
      setNotifFrom(cfg.fromAddress);
      setNotifTo(cfg.toAddress);
    }).catch(() => {});
    api.getNotificationLogs().then(setNotifLogs).catch(() => {});
  }, []);

  async function saveNotifications(e: React.FormEvent) {
    e.preventDefault();
    setSavingNotif(true);
    setNotifError("");
    setNotifSuccess("");
    try {
      const updated = await api.updateNotificationConfig({
        enabled: notifEnabled,
        provider: notifProvider,
        fromAddress: notifFrom,
        toAddress: notifTo,
        credentialId: notifCredentialId,
      });
      setNotifConfig(updated);
      setNotifSuccess("Notification settings saved.");
    } catch (err) {
      setNotifError(err instanceof ApiError ? err.message : "Failed to save notification settings");
    } finally {
      setSavingNotif(false);
    }
  }

  async function sendTestNotification() {
    setTestingNotif(true);
    setNotifError("");
    setNotifSuccess("");
    try {
      await api.testNotification();
      setNotifSuccess("Test email sent successfully.");
    } catch (err) {
      setNotifError(err instanceof ApiError ? err.message : "Failed to send test email");
    } finally {
      setTestingNotif(false);
      api.getNotificationLogs().then(setNotifLogs).catch(() => {});
    }
  }

  return (
      <div className="card" style={{ maxWidth: 560 }}>
        <div className="card-title"><Bell size={13} />Notifications</div>
        {notifError && <div className="alert alert-error">{notifError}</div>}
        {notifSuccess && (
          <div className="alert alert-success">
            <Check size={14} />{notifSuccess}
          </div>
        )}
        <form className={styles.settingsForm} onSubmit={(e) => void saveNotifications(e)}>
          <div className="field">
            <label>Provider</label>
            <AppSelect
              value={notifProvider}
              onValueChange={(value) => setNotifProvider(value as NotificationConfig["provider"])}
              options={[
                { value: "resend", label: "Resend" },
                { value: "mw", label: "MW Email Service" },
              ]}
            />
          </div>
          <div className="field">
            <label>API key</label>
            <ApiKeySelect
              credentials={apiKeyCredentials}
              value={notifCredentialId}
              onValueChange={setNotifCredentialId}
              placeholder={notifProvider === "mw" ? "MW Email Service API key" : "Resend API key"}
            />
            {apiKeyCredentials.length === 0 && (
              <span className="hint">Add an API Key credential on the <Link className="ext-link" to="/credentials">Credentials page</Link> first.</span>
            )}
          </div>
          <div className="field">
            <label>From address</label>
            <input
              type="email"
              value={notifFrom}
              onChange={(e) => setNotifFrom(e.target.value)}
              placeholder="alerts@yourdomain.com"
              required
            />
          </div>
          <div className="field">
            <label>To address</label>
            <input
              type="email"
              value={notifTo}
              onChange={(e) => setNotifTo(e.target.value)}
              placeholder="you@example.com"
              required
            />
          </div>
          <div className="field">
            <label className={styles.switchField}>
              <Switch checked={notifEnabled} onCheckedChange={setNotifEnabled} />
              <span>
                <span>Enable notifications</span>
                <span>Send project health alerts to the configured email address.</span>
              </span>
            </label>
          </div>
          <div className="row-actions">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void sendTestNotification()}
              disabled={testingNotif || !notifConfig?.hasApiKey}
              title={!notifConfig?.hasApiKey ? "Save API key first" : undefined}
            >
              {testingNotif ? <Loader size={13} className="spin" /> : <Send size={13} />}
              Send test
            </button>
            <button type="submit" className="btn btn-primary" disabled={savingNotif}>
              {savingNotif ? <Loader size={13} className="spin" /> : <Check size={13} />}
              Save
            </button>
          </div>
        </form>
        {notifLogs.length > 0 && (
          <>
            <div className="card-title" style={{ marginTop: 20 }}>Email Log</div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Type</th><th>Result</th><th>Project</th><th>Sent</th></tr>
                </thead>
                <tbody>
                  {notifLogs.slice(0, 10).map((log) => (
                    <tr key={log.id}>
                      <td>{log.eventType === "test" ? "Test" : "Alert"}</td>
                      <td style={{ color: log.result === "ok" ? "var(--success)" : "var(--danger)" }}>
                        {log.result === "ok" ? <Check size={12} style={{ display: "inline", marginRight: 4 }} /> : <AlertCircle size={12} style={{ display: "inline", marginRight: 4 }} />}
                        {log.result}
                      </td>
                      <td>{log.projectName ?? "—"}</td>
                      <td>{formatShortDateTime(log.sentAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
  );
}
