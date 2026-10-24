import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle, Loader, Plus, RefreshCw, Shield, ShieldCheck, Trash2, UploadCloud, X } from "lucide-react";
import { AppSelect } from "../../components/AppSelect";
import { useConfirm } from "../../components/ConfirmDialog";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { api, ApiError } from "../../api/client";
import type { FirewallAction, FirewallProfile, FirewallProtocol, FirewallSource, ProviderFirewall } from "../../api/types";
import { useSystem } from "../../context/SystemContext";
import { notify } from "../../lib/notify";
import { cn } from "../../lib/utils";
import styles from "../System.module.scss";

function PanelSkeleton() {
  return (
    <div className={styles.skeletonGrid}>
      <div className={styles.skeletonCard}>
        <div className={styles.skeletonLine} />
        <div className={styles.skeletonLineShort} />
        <div className={styles.skeletonBlock} />
      </div>
    </div>
  );
}

/** The VPS provider's firewall (Hostinger API): local profiles and rules, synced to the provider. */
export default function FirewallPanel() {
  const { vps: vpsData, refreshVps } = useSystem();
  const [firewallProviderId, setFirewallProviderId] = useState<number | "">("");
  const [firewallProfiles, setFirewallProfiles] = useState<FirewallProfile[]>([]);
  const [providerFirewalls, setProviderFirewalls] = useState<ProviderFirewall[]>([]);
  const [selectedFirewallProfileId, setSelectedFirewallProfileId] = useState<number | "">("");
  const [selectedFirewallVmId, setSelectedFirewallVmId] = useState("");
  const [firewallProfileName, setFirewallProfileName] = useState("STACKPORT Firewall");
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [ruleFormOpen, setRuleFormOpen] = useState(false);
  const [firewallAction, setFirewallAction] = useState<FirewallAction>("accept");
  const [firewallProtocol, setFirewallProtocol] = useState<FirewallProtocol>("TCP");
  const [firewallPort, setFirewallPort] = useState("22");
  const [firewallSource, setFirewallSource] = useState<FirewallSource>("any");
  const [firewallSourceDetail, setFirewallSourceDetail] = useState("any");
  const [loadingFirewall, setLoadingFirewall] = useState(false);
  const [syncingFirewall, setSyncingFirewall] = useState(false);
  const [firewallError, setFirewallError] = useState("");
  const [firewallSuccess, setFirewallSuccess] = useState("");
  const confirm = useConfirm();
  const vpsProviders = vpsData?.providers ?? [];
  const monitoredVms = vpsData?.monitored ?? [];
  const selectedFirewallProfile = firewallProfiles.find((profile) => profile.id === selectedFirewallProfileId) ?? firewallProfiles[0] ?? null;
  const firewallMonitoredVms = monitoredVms.filter((vm) => vm.providerId === firewallProviderId);

  useEffect(() => {
    if (firewallProviderId === "" && vpsProviders.length > 0) {
      setFirewallProviderId(vpsProviders[0].id);
    }
  }, [firewallProviderId, vpsProviders]);

  useEffect(() => {
    if (firewallProviderId === "") return;
    void refreshFirewallData(firewallProviderId);
  }, [firewallProviderId]);

  useEffect(() => {
    if (selectedFirewallProfile && selectedFirewallProfileId === "") {
      setSelectedFirewallProfileId(selectedFirewallProfile.id);
    }
  }, [selectedFirewallProfile, selectedFirewallProfileId]);

  const FIREWALL_PROTOCOLS: FirewallProtocol[] = ["TCP", "UDP", "ICMP", "GRE", "any", "ESP", "AH", "ICMPv6", "SSH", "HTTP", "HTTPS", "MySQL", "PostgreSQL"];

  function providerFirewallData(firewall: ProviderFirewall): ProviderFirewall["data"] & ProviderFirewall {
    return firewall.data ? { ...firewall, ...firewall.data } : firewall;
  }

  async function refreshFirewallData(nextProviderId = firewallProviderId) {
    if (nextProviderId === "") return;
    setLoadingFirewall(true);
    setFirewallError("");
    try {
      const [localProfiles, remoteFirewalls] = await Promise.all([
        api.listFirewallProfiles(nextProviderId),
        api.listProviderFirewalls(nextProviderId),
      ]);
      setFirewallProfiles(localProfiles);
      setProviderFirewalls(remoteFirewalls);
      if (localProfiles.length > 0) {
        setSelectedFirewallProfileId((current) => localProfiles.some((profile) => profile.id === current) ? current : localProfiles[0].id);
      } else {
        setSelectedFirewallProfileId("");
      }
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Failed to load firewall data";
      setFirewallError(message);
      notify.error(err, "Failed to load firewall data");
    } finally {
      setLoadingFirewall(false);
    }
  }

  async function handleCreateFirewallProfile(e: React.FormEvent) {
    e.preventDefault();
    if (firewallProviderId === "") return;
    setLoadingFirewall(true);
    setFirewallError("");
    setFirewallSuccess("");
    try {
      const profile = await api.createFirewallProfile({
        providerId: firewallProviderId,
        name: firewallProfileName,
      });
      setSelectedFirewallProfileId(profile.id);
      setFirewallProfileName("STACKPORT Firewall");
      setProfileModalOpen(false);
      await refreshFirewallData(firewallProviderId);
      setFirewallSuccess("Firewall profile created.");
      notify.success("Firewall profile created.");
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Failed to create firewall profile";
      setFirewallError(message);
      notify.error(err, "Failed to create firewall profile");
    } finally {
      setLoadingFirewall(false);
    }
  }

  async function deleteFirewallProfile() {
    if (!selectedFirewallProfile) return;
    const ok = await confirm({
      title: "Delete firewall profile?",
      description: `${selectedFirewallProfile.name} and its local rules will be removed. Provider firewalls are not changed.`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    setLoadingFirewall(true);
    setFirewallError("");
    setFirewallSuccess("");
    try {
      await api.deleteFirewallProfile(selectedFirewallProfile.id);
      setSelectedFirewallProfileId("");
      await refreshFirewallData(selectedFirewallProfile.providerId);
      setFirewallSuccess("Firewall profile deleted.");
      notify.success("Firewall profile deleted.");
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Failed to delete firewall profile";
      setFirewallError(message);
      notify.error(err, "Failed to delete firewall profile");
    } finally {
      setLoadingFirewall(false);
    }
  }

  async function addFirewallRule(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedFirewallProfile) return;
    setLoadingFirewall(true);
    setFirewallError("");
    setFirewallSuccess("");
    try {
      await api.createFirewallRule(selectedFirewallProfile.id, {
        action: firewallAction,
        protocol: firewallProtocol,
        port: firewallPort,
        source: firewallSource,
        sourceDetail: firewallSource === "any" ? "any" : firewallSourceDetail,
      });
      await refreshFirewallData(selectedFirewallProfile.providerId);
      setRuleFormOpen(false);
      setFirewallSuccess("Rule added to our firewall profile.");
      notify.success("Firewall rule added.");
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Failed to add firewall rule";
      setFirewallError(message);
      notify.error(err, "Failed to add firewall rule");
    } finally {
      setLoadingFirewall(false);
    }
  }

  async function removeFirewallRule(ruleId: number) {
    if (!selectedFirewallProfile) return;
    setLoadingFirewall(true);
    setFirewallError("");
    setFirewallSuccess("");
    try {
      await api.deleteFirewallRule(selectedFirewallProfile.id, ruleId);
      await refreshFirewallData(selectedFirewallProfile.providerId);
      setFirewallSuccess("Rule removed from our firewall profile.");
      notify.success("Firewall rule removed.");
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Failed to delete firewall rule";
      setFirewallError(message);
      notify.error(err, "Failed to delete firewall rule");
    } finally {
      setLoadingFirewall(false);
    }
  }

  async function syncFirewallProfile(activate = false) {
    if (!selectedFirewallProfile) return;
    const toastId = notify.loading(activate ? "Activating firewall profile..." : "Syncing firewall profile...");
    setSyncingFirewall(true);
    setFirewallError("");
    setFirewallSuccess("");
    try {
      const result = await api.syncFirewallProfile(selectedFirewallProfile.id, {
        vmId: selectedFirewallVmId || null,
        activate,
      });
      await refreshFirewallData(selectedFirewallProfile.providerId);
      setFirewallSuccess(activate
        ? `Activated ${selectedFirewallProfile.name} and synced ${result.createdRules} rule${result.createdRules === 1 ? "" : "s"}.`
        : `Synced ${result.createdRules} rule${result.createdRules === 1 ? "" : "s"} to provider firewall.`);
      notify.success(activate ? "Firewall profile activated." : "Firewall profile synced.", { id: toastId });
      refreshVps();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : activate ? "Failed to activate firewall profile" : "Failed to sync firewall profile";
      setFirewallError(message);
      notify.error(err, activate ? "Failed to activate firewall profile" : "Failed to sync firewall profile", { id: toastId });
    } finally {
      setSyncingFirewall(false);
    }
  }

  return (
    <section className={styles.systemPanel}>
      <div className={styles.sectionTitle}>
        <Shield size={14} />
        Firewall
        {vpsProviders.length > 0 && (
          <span className={cn("mono", styles.titleMeta)}>
            {vpsProviders.length} provider{vpsProviders.length === 1 ? "" : "s"}
          </span>
        )}
        <div className={cn("row-actions", styles.titleActions)}>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => void refreshFirewallData()}
            disabled={firewallProviderId === "" || loadingFirewall}
            title="Reload local and provider firewall state"
          >
            {loadingFirewall ? <Loader size={12} className="spin" /> : <RefreshCw size={12} />}
            Refresh
          </Button>
        </div>
      </div>

      {firewallError && (
        <Alert className={styles.softAlert}>
          <AlertCircle size={14} />
          <AlertDescription>{firewallError}</AlertDescription>
        </Alert>
      )}
      {firewallSuccess && (
        <Alert className={cn(styles.softAlert, styles.successAlert)}>
          <CheckCircle size={14} />
          <AlertDescription>{firewallSuccess}</AlertDescription>
        </Alert>
      )}

      {vpsData === null ? (
        <PanelSkeleton />
      ) : (
        <>
          <div className={styles.firewallToolbar}>
            <div className="field">
              <label>Provider</label>
              <AppSelect
                value={firewallProviderId === "" ? "" : String(firewallProviderId)}
                onValueChange={(value) => {
                  setFirewallProviderId(value ? Number(value) : "");
                  setFirewallSuccess("");
                }}
                options={vpsProviders.length > 0
                  ? vpsProviders.map((provider) => ({ value: String(provider.id), label: provider.name }))
                  : [{ value: "", label: "No providers", disabled: true }]}
                disabled={vpsProviders.length === 0}
              />
            </div>
            <div className="field">
              <label>Our profiles</label>
              <div className={styles.firewallProfilePicker}>
                <AppSelect
                  value={selectedFirewallProfileId === "" ? "" : String(selectedFirewallProfileId)}
                  onValueChange={(value) => setSelectedFirewallProfileId(value ? Number(value) : "")}
                  options={firewallProfiles.length > 0
                    ? firewallProfiles.map((profile) => ({ value: String(profile.id), label: profile.name }))
                    : [{ value: "", label: "No profiles", disabled: true }]}
                  disabled={firewallProfiles.length === 0}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className={styles.firewallProfileAddButton}
                  onClick={() => setProfileModalOpen(true)}
                  disabled={firewallProviderId === ""}
                  title="Add local firewall profile"
                  aria-label="Add local firewall profile"
                >
                  <Plus size={12} />
                </Button>
              </div>
            </div>
            <div className="field">
              <label>Sync target VM</label>
              <AppSelect
                value={selectedFirewallVmId}
                onValueChange={setSelectedFirewallVmId}
                options={[
                  { value: "", label: "Do not sync to VM" },
                  ...firewallMonitoredVms.map((vm) => ({ value: vm.vmId, label: vm.label || vm.vmId })),
                ]}
              />
            </div>
          </div>

          <div className={styles.firewallGrid}>
            <section className={styles.firewallPane}>
              <div className={styles.firewallPaneHeader}>
                <div className={styles.firewallPaneTitle}>
                  <strong>Our rules</strong>
                  <span>{selectedFirewallProfile?.name ?? "No profile selected"}</span>
                </div>
                <div className="row-actions">
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => setRuleFormOpen((open) => !open)}
                    disabled={!selectedFirewallProfile}
                    title="Add local firewall rule"
                  >
                    <Plus size={12} />
                    Add rule
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    onClick={() => void syncFirewallProfile(false)}
                    disabled={!selectedFirewallProfile || syncingFirewall || selectedFirewallProfile.rules.length === 0}
                    title="Push local rules to the linked provider firewall"
                  >
                    {syncingFirewall ? <Loader size={12} className="spin" /> : <UploadCloud size={12} />}
                    Sync rules
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => void syncFirewallProfile(true)}
                    disabled={!selectedFirewallProfile || syncingFirewall || selectedFirewallProfile.rules.length === 0 || !selectedFirewallVmId}
                    title="Sync and activate this local profile on the selected VM"
                  >
                    {syncingFirewall ? <Loader size={12} className="spin" /> : <ShieldCheck size={12} />}
                    Activate local profile
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className={styles.dangerButton}
                    onClick={() => void deleteFirewallProfile()}
                    disabled={!selectedFirewallProfile || loadingFirewall}
                    title="Delete local firewall profile"
                  >
                    <Trash2 size={12} />
                    Delete
                  </Button>
                </div>
              </div>

              {ruleFormOpen && (
                <form className={styles.firewallRuleEditor} onSubmit={(event) => void addFirewallRule(event)}>
                  <div className="field">
                    <label>Action</label>
                    <AppSelect
                      value={firewallAction}
                      onValueChange={(value) => setFirewallAction(value as FirewallAction)}
                      options={[
                        { value: "accept", label: "accept" },
                        { value: "drop", label: "drop" },
                      ]}
                    />
                  </div>
                  <div className="field">
                    <label>Protocol</label>
                    <AppSelect
                      value={firewallProtocol}
                      onValueChange={(value) => setFirewallProtocol(value as FirewallProtocol)}
                      options={FIREWALL_PROTOCOLS.map((value) => ({ value, label: value }))}
                    />
                  </div>
                  <div className="field">
                    <label>Port</label>
                    <Input
                      type="text"
                      className={styles.formInput}
                      value={firewallPort}
                      onChange={(event) => setFirewallPort(event.target.value)}
                      placeholder="22, 80, 443"
                    />
                  </div>
                  <div className="field">
                    <label>Source</label>
                    <AppSelect
                      value={firewallSource}
                      onValueChange={(value) => {
                        setFirewallSource(value as FirewallSource);
                        if (value === "any") setFirewallSourceDetail("any");
                      }}
                      options={[
                        { value: "any", label: "any" },
                        { value: "custom", label: "custom" },
                      ]}
                    />
                  </div>
                  <div className="field field-wide">
                    <label>Source detail</label>
                    <Input
                      type="text"
                      className={styles.formInput}
                      value={firewallSourceDetail}
                      onChange={(event) => setFirewallSourceDetail(event.target.value)}
                      disabled={firewallSource === "any"}
                      placeholder="CIDR/IP"
                    />
                  </div>
                  <div className={styles.firewallRuleEditorActions}>
                    <Button type="button" variant="ghost" size="xs" onClick={() => setRuleFormOpen(false)}>
                      Cancel
                    </Button>
                    <Button type="submit" variant="outline" size="xs" disabled={!selectedFirewallProfile || loadingFirewall}>
                      <Plus size={12} />
                      Add local rule
                    </Button>
                  </div>
                </form>
              )}

              {!selectedFirewallProfile ? (
                <div className={styles.panelEmpty}>Create a local firewall profile first.</div>
              ) : selectedFirewallProfile.rules.length === 0 ? (
                <div className={styles.panelEmpty}>No local rules yet.</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Action</TableHead>
                      <TableHead>Protocol</TableHead>
                      <TableHead>Port</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {selectedFirewallProfile.rules.map((rule) => (
                      <TableRow key={rule.id}>
                        <TableCell>{rule.action}</TableCell>
                        <TableCell>{rule.protocol}</TableCell>
                        <TableCell className="mono">{rule.port}</TableCell>
                        <TableCell className="mono">{rule.source === "any" ? "any" : rule.sourceDetail}</TableCell>
                        <TableCell><Badge variant="outline" className={styles.statusChip}>local only</Badge></TableCell>
                        <TableCell>
                          <Button
                            type="button"
                            variant="outline"
                            size="xs"
                            className={styles.dangerButton}
                            onClick={() => void removeFirewallRule(rule.id)}
                          >
                            <Trash2 size={12} />
                            Remove
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </section>

            <section className={styles.firewallPane}>
              <div className={styles.firewallPaneHeader}>
                <strong>Provider firewalls</strong>
                <span className="muted-text">Read only until sync</span>
              </div>
              {providerFirewalls.length === 0 ? (
                <div className={styles.panelEmpty}>No provider firewalls loaded.</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>ID</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Synced</TableHead>
                      <TableHead>Rules</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {providerFirewalls.map((rawFirewall) => {
                      const firewall = providerFirewallData(rawFirewall);
                      const firewallId = String(firewall.id ?? "");
                      return (
                        <TableRow key={firewallId || firewall.name}>
                          <TableCell className="mono">{firewallId || "-"}</TableCell>
                          <TableCell>{firewall.name ?? "-"}</TableCell>
                          <TableCell>{firewall.is_synced == null ? "-" : firewall.is_synced ? "yes" : "no"}</TableCell>
                          <TableCell>{firewall.rules?.length ?? "-"}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </section>
          </div>

          {profileModalOpen && (
            <div className="modal-backdrop" role="presentation" onMouseDown={() => setProfileModalOpen(false)}>
              <form
                className={cn("modal-panel", styles.firewallProfileModal)}
                role="dialog"
                aria-modal="true"
                aria-label="Add firewall profile"
                onMouseDown={(event) => event.stopPropagation()}
                onSubmit={(event) => void handleCreateFirewallProfile(event)}
              >
                <div className={styles.firewallModalHeader}>
                  <div>
                    <h2>Add firewall profile</h2>
                    <p>Profiles are local until you sync or activate them.</p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => setProfileModalOpen(false)}
                    title="Close"
                  >
                    <X size={12} />
                  </Button>
                </div>
                <div className="field">
                  <label>Profile name</label>
                  <Input
                    type="text"
                    className={styles.formInput}
                    value={firewallProfileName}
                    onChange={(event) => setFirewallProfileName(event.target.value)}
                    autoFocus
                  />
                </div>
                <div className={styles.firewallModalActions}>
                  <Button type="button" variant="outline" size="sm" onClick={() => setProfileModalOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" size="sm" disabled={firewallProviderId === "" || loadingFirewall || !firewallProfileName.trim()}>
                    {loadingFirewall ? <Loader size={13} className="spin" /> : <Plus size={13} />}
                    Add profile
                  </Button>
                </div>
              </form>
            </div>
          )}
        </>
      )}
    </section>
  );

}
