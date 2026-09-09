import { useEffect, useState } from "react";
import { Plug, Server, Monitor, Bell, Check, RefreshCw, Loader, Plus, Trash2, Send, AlertCircle } from "lucide-react";
import { ActionSelect, AppSelect } from "../components/AppSelect";
import { ApiKeySelect } from "../components/ApiKeySelect";
import { Switch } from "../components/ui/switch";
import { api, ApiError } from "../api/client";
import type { MonitoredVm, VpsData, NotificationConfig, NotificationLogEntry, Credential } from "../api/types";
import { formatShortDateTime } from "../lib/format";
import { useChannelData } from "../context/SocketContext";
import styles from "./Integrations.module.scss";

export default function Integrations() {
  const { data: vpsData, refresh: refreshVps } = useChannelData<VpsData>("vps", { fallback: () => api.getVm() });
  const [providerName, setProviderName] = useState("Hostinger");
  const [providerFormId, setProviderFormId] = useState<number | null>(null);
  const [selectedProviderId, setSelectedProviderId] = useState<number | "">("");
  const [providerCredentialId, setProviderCredentialId] = useState<number | null>(null);
  const [savingProvider, setSavingProvider] = useState(false);
  const [availableVms, setAvailableVms] = useState<Record<string, unknown>[]>([]);
  const [listing, setListing] = useState(false);
  const [vpsError, setVpsError] = useState("");
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

  const providers = vpsData?.providers ?? [];
  const provider = providers.find((item) => item.id === selectedProviderId) ?? providers[0] ?? null;
  const monitored = vpsData?.monitored ?? [];

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

  useEffect(() => {
    if (selectedProviderId === "" && providers.length > 0) {
      setSelectedProviderId(providers[0].id);
    }
  }, [providers, selectedProviderId]);

  useEffect(() => {
    if (providerFormId == null) return;
    const editingProvider = providers.find((item) => item.id === providerFormId);
    if (editingProvider) setProviderName(editingProvider.name);
  }, [providerFormId, providers]);

  async function saveProvider(e: React.FormEvent) {
    e.preventDefault();
    setSavingProvider(true);
    setVpsError("");
    try {
      await api.saveHostingerProvider({ id: providerFormId ?? undefined, name: providerName, credentialId: providerCredentialId });
      setProviderCredentialId(null);
      setProviderName("Hostinger");
      setProviderFormId(null);
      refreshVps();
    } catch (err) {
      setVpsError(err instanceof ApiError ? err.message : "Failed to save provider");
    } finally {
      setSavingProvider(false);
    }
  }

  async function listVms() {
    if (!provider) return;
    setListing(true);
    setVpsError("");
    try {
      setAvailableVms(await api.listProviderVms(provider.id));
    } catch (err) {
      setVpsError(err instanceof ApiError ? err.message : "Failed to list VMs");
    } finally {
      setListing(false);
    }
  }

  async function monitorVm(vm: Record<string, unknown>) {
    if (!provider) return;
    const vmId = String(vm.id ?? "");
    if (!vmId) return;
    await api.addMonitoredVm({
      providerId: provider.id,
      vmId,
      label: typeof vm.hostname === "string" ? vm.hostname : null,
    });
    refreshVps();
  }

  async function removeVm(vm: MonitoredVm) {
    await api.removeMonitoredVm(vm.id);
    refreshVps();
  }

  function editProvider(id: number) {
    const editingProvider = providers.find((item) => item.id === id);
    if (!editingProvider) return;
    setProviderFormId(id);
    setProviderName(editingProvider.name);
    setProviderCredentialId(editingProvider.credentialId);
  }

  function cancelProviderEdit() {
    setProviderFormId(null);
    setProviderName("Hostinger");
    setProviderCredentialId(null);
  }

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
    <main className="main">
      <h1 className="page-title"><Plug size={20} />Integrations</h1>

      <div className="card">
        <div className="card-title"><Server size={13} />VPS Provider</div>
        {vpsError && <div className="alert alert-error">{vpsError}</div>}
        <form className={styles.vpsProviderForm} onSubmit={(e) => void saveProvider(e)}>
          <div className="field">
            <label>Type</label>
            <AppSelect
              value="hostinger"
              options={[{ value: "hostinger", label: "Hostinger" }]}
              disabled
            />
          </div>
          <div className="field">
            <label>Name</label>
            <input type="text" value={providerName} onChange={(e) => setProviderName(e.target.value)} />
          </div>
          <div className="field field-wide">
            <label>API key</label>
            <ApiKeySelect
              credentials={apiKeyCredentials}
              value={providerCredentialId}
              onValueChange={setProviderCredentialId}
              placeholder="Hostinger API key"
            />
            {apiKeyCredentials.length === 0 && (
              <span className="hint">Add an API Key credential on the Credentials page first.</span>
            )}
          </div>
          <div className="row-actions">
            {providerFormId && (
              <button className="btn btn-ghost" type="button" onClick={cancelProviderEdit}>
                Cancel
              </button>
            )}
            <button className="btn btn-primary" type="submit" disabled={savingProvider || (!providerCredentialId && !providerFormId)}>
              {savingProvider ? <Loader size={13} className="spin" /> : <Plus size={13} />}
              {providerFormId ? "Update" : "Add"}
            </button>
          </div>
        </form>

        {providers.length > 0 && (
          <div className="table-wrap" style={{ marginTop: 14 }}>
            <table>
              <thead>
                <tr><th>Name</th><th>Type</th><th>Key</th><th></th></tr>
              </thead>
              <tbody>
                {providers.map((item) => (
                  <tr key={item.id}>
                    <td>{item.name}</td>
                    <td>{item.type}</td>
                    <td>{item.hasApiKey ? "Saved" : "-"}</td>
                    <td>
                      <button className="btn btn-ghost btn-sm" onClick={() => editProvider(item.id)}>
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title">
          <Monitor size={13} />
          VPS Monitoring
          <div className="row-actions" style={{ marginLeft: "auto" }}>
            <ActionSelect
              className={styles.providerActionSelect}
              value={selectedProviderId === "" ? "" : String(selectedProviderId)}
              onValueChange={(value) => {
                setSelectedProviderId(value ? Number(value) : "");
                setAvailableVms([]);
              }}
              options={providers.length > 0
                ? providers.map((item) => ({ value: String(item.id), label: item.name }))
                : [{ value: "", label: "No providers", disabled: true }]}
              placeholder="Provider"
              disabled={providers.length === 0}
              action={(
                <button className="btn btn-ghost btn-sm" onClick={() => void listVms()} disabled={!provider || listing}>
                  {listing ? <Loader size={13} className="spin" /> : <RefreshCw size={13} />}
                  List VMs
                </button>
              )}
            />
          </div>
        </div>

        {availableVms.length > 0 && (
          <div className="table-wrap" style={{ marginBottom: 14 }}>
            <table>
              <thead>
                <tr><th>ID</th><th>Hostname</th><th>State</th><th></th></tr>
              </thead>
              <tbody>
                {availableVms.map((vm) => {
                  const vmId = String(vm.id ?? "");
                  const isMonitored = monitored.some((item) => item.providerId === provider?.id && item.vmId === vmId);
                  return (
                    <tr key={vmId}>
                      <td className="mono">{vmId}</td>
                      <td>{String(vm.hostname ?? vm.name ?? "-")}</td>
                      <td>{String(vm.state ?? "-")}</td>
                      <td>
                        <button className="btn btn-ghost btn-sm" onClick={() => void monitorVm(vm)} disabled={isMonitored}>
                          <Plus size={12} />
                          {isMonitored ? "Monitored" : "Monitor"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {monitored.length === 0 ? (
          <div className="empty">{provider ? "No monitored VMs yet." : "Configure Hostinger first."}</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>VM ID</th><th>Label</th><th>Provider</th><th></th></tr>
              </thead>
              <tbody>
                {monitored.map((vm) => (
                  <tr key={vm.id}>
                    <td className="mono">{vm.vmId}</td>
                    <td>{vm.label ?? "-"}</td>
                    <td>{providers.find((item) => item.id === vm.providerId)?.name ?? vm.providerId}</td>
                    <td>
                      <button className="btn btn-danger" onClick={() => void removeVm(vm)}>
                        <Trash2 size={12} />
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
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
              <span className="hint">Add an API Key credential on the Credentials page first.</span>
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
    </main>
  );
}
