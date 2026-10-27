import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertCircle, Bell, Check, KeyRound, Loader, Mail, Save, Send } from "lucide-react";
import { AppSelect } from "../../components/AppSelect";
import { ApiKeySelect } from "../../components/ApiKeySelect";
import { Button } from "../../components/ui/button";
import { Switch } from "../../components/ui/switch";
import { api } from "../../api/client";
import type { NotificationConfig, NotificationLogEntry, Credential } from "../../api/types";
import { formatShortDateTime } from "../../lib/format";
import { notify } from "../../lib/notify";
import { cn } from "../../lib/utils";
import styles from "../Settings.module.scss";
import systemStyles from "../System.module.scss";

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
  const [notifLogs, setNotifLogs] = useState<NotificationLogEntry[]>([]);

  useEffect(() => {
    api.listCredentials().then((creds) => {
      setApiKeyCredentials(creds.filter((c) => c.type === "api_key"));
    }).catch(() => {});
  }, []);

  function applyConfig(cfg: NotificationConfig) {
    setNotifConfig(cfg);
    setNotifEnabled(cfg.enabled);
    setNotifProvider(cfg.provider);
    setNotifCredentialId(cfg.credentialId);
    setNotifFrom(cfg.fromAddress);
    setNotifTo(cfg.toAddress);
  }

  useEffect(() => {
    api.getNotificationConfig().then(applyConfig).catch(() => {});
    api.getNotificationLogs().then(setNotifLogs).catch(() => {});
  }, []);

  const changed = notifConfig ? (
    notifEnabled !== notifConfig.enabled ||
    notifProvider !== notifConfig.provider ||
    notifCredentialId !== notifConfig.credentialId ||
    notifFrom !== notifConfig.fromAddress ||
    notifTo !== notifConfig.toAddress
  ) : true;

  async function saveNotifications(e?: React.FormEvent) {
    e?.preventDefault();
    setSavingNotif(true);
    try {
      applyConfig(await api.updateNotificationConfig({
        enabled: notifEnabled,
        provider: notifProvider,
        fromAddress: notifFrom,
        toAddress: notifTo,
        credentialId: notifCredentialId,
      }));
      notify.success("Notification settings saved.");
    } catch (err) {
      notify.error(err, "Failed to save notification settings");
    } finally {
      setSavingNotif(false);
    }
  }

  async function sendTestNotification() {
    setTestingNotif(true);
    try {
      await api.testNotification();
      notify.success("Test email sent.");
    } catch (err) {
      notify.error(err, "Failed to send test email");
    } finally {
      setTestingNotif(false);
      api.getNotificationLogs().then(setNotifLogs).catch(() => {});
    }
  }

  const testBlocked = !notifConfig?.hasApiKey ? "Save an API key first" : changed ? "Save your changes first" : undefined;

  return (
    <div className={styles.sectionStack}>
      <section className={systemStyles.systemPanel}>
        <div className={systemStyles.sectionTitle}>
          <Bell size={14} />
          Email alerts
          {notifConfig && (
            <span className={cn(systemStyles.titleMeta, "mono")} style={{ fontSize: "0.78rem" }}>
              {notifConfig.enabled ? "enabled" : "disabled"}
            </span>
          )}
          <div className={cn("row-actions", systemStyles.titleActions)}>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => void sendTestNotification()}
              disabled={testingNotif || !!testBlocked}
              title={testBlocked ?? "Send a test email to the To address"}
            >
              {testingNotif ? <Loader size={12} className="spin" /> : <Send size={12} />}
              Send test
            </Button>
            <Button
              type="submit"
              form="notification-settings"
              variant="outline"
              size="xs"
              disabled={savingNotif || !changed}
            >
              {savingNotif ? <Loader size={12} className="spin" /> : <Save size={12} />}
              Save
            </Button>
          </div>
        </div>
        <form id="notification-settings" className={styles.settingsForm} onSubmit={(e) => void saveNotifications(e)}>
          <label className={styles.switchField}>
            <Switch checked={notifEnabled} onCheckedChange={setNotifEnabled} />
            <span>
              <span>Enable notifications</span>
              <span>Send project health alerts to the configured email address.</span>
            </span>
          </label>
          <div className={styles.fieldGrid}>
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
              <label><KeyRound size={12} />API key</label>
              <ApiKeySelect
                credentials={apiKeyCredentials}
                value={notifCredentialId}
                onValueChange={setNotifCredentialId}
                placeholder={notifProvider === "mw" ? "MW Email Service API key" : "Resend API key"}
              />
              {apiKeyCredentials.length === 0 && (
                <span className="hint">Add an API Key credential on the <Link className="ext-link" to="/settings/credentials">Credentials</Link> first.</span>
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
          </div>
        </form>
      </section>

      <section className={systemStyles.systemPanel}>
        <div className={systemStyles.sectionTitle}>
          <Mail size={14} />
          Email log
          <span className={systemStyles.titleMeta}>last 10</span>
        </div>
        {notifLogs.length === 0 ? (
          <p className="muted-text" style={{ margin: 0, fontSize: "0.82rem" }}>No emails sent yet.</p>
        ) : (
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
        )}
      </section>
    </div>
  );
}
