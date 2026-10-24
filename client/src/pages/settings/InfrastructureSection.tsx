import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Server, Monitor, RefreshCw, Loader, Plus, Trash2 } from "lucide-react";
import { ActionSelect, AppSelect } from "../../components/AppSelect";
import { ApiKeySelect } from "../../components/ApiKeySelect";
import { api, ApiError } from "../../api/client";
import type { MonitoredVm, VpsData, Credential } from "../../api/types";
import { useChannelData } from "../../context/SocketContext";
import FirewallPanel from "./FirewallPanel";
import styles from "../Settings.module.scss";

/** VPS provider (Hostinger), the VMs Stackport monitors, and the provider's firewall. */
export default function InfrastructureSection() {
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

  const providers = vpsData?.providers ?? [];
  const provider = providers.find((item) => item.id === selectedProviderId) ?? providers[0] ?? null;
  const monitored = vpsData?.monitored ?? [];

  useEffect(() => {
    api.listCredentials().then((creds) => {
      setApiKeyCredentials(creds.filter((c) => c.type === "api_key"));
    }).catch(() => {});
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

  return (
    <>
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
              <span className="hint">Add an API Key credential on the <Link className="ext-link" to="/credentials">Credentials page</Link> first.</span>
            )}
          </div>
          <div className="row-actions">
            {providerFormId && (
              <button className="btn btn-ghost" type="button" onClick={cancelProviderEdit}>
                Cancel
              </button>
            )}
            <button className="btn btn-primary" type="submit" disabled={savingProvider || (!providerCredentialId && !providerFormId)}
              title={!providerCredentialId && !providerFormId ? "Pick an API key credential first" : undefined}>
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
                <button className="btn btn-ghost btn-sm" onClick={() => void listVms()} disabled={!provider || listing}
                  title={!provider ? "Pick a provider first" : "Fetch this provider's VMs"}>
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
      {providers.length > 0 && <FirewallPanel />}
    </>
  );
}
