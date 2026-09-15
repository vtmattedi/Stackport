import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Cpu, RefreshCw, Loader, Box, Layers, CheckCircle, AlertCircle,
  RotateCw, Play, Square, Hammer, ChevronDown, ChevronRight, X, FileText, Save, Eye, Settings,
  ShieldCheck, ShieldX, KeyRound, Trash2, Download, Mail, GitBranch, Shield, Plus, UploadCloud,
  SquareTerminal, Radio,
} from "lucide-react";
import NginxCode from "../components/NginxCode";
import { AppSelect } from "../components/AppSelect";
import { GitHubTokenSelect } from "../components/GitHubTokenSelect";
import { ContainerShellDialog } from "../components/ContainerShellDialog";
import { ContainerLogDialog } from "../components/ContainerLogDialog";
import { useConfirm } from "../components/ConfirmDialog";
import { StatusChip } from "../components/StatusChip";
import { api, ApiError } from "../api/client";
import type {
  ComposeStack,
  ContainerInfo,
  NginxAppConfig,
  NginxDocument,
  NginxDocumentKind,
  CertbotEntry,
  GitHubPollerConfig,
  Credential,
  FirewallAction,
  FirewallProfile,
  FirewallProtocol,
  FirewallSource,
  ProviderFirewall,
  DockerStorageThresholds,
} from "../api/types";
import { useSystem } from "../context/SystemContext";
import { formatShortDateTime } from "../lib/format";
import { cn } from "../lib/utils";
import styles from "./System.module.scss";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/tabs";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Alert, AlertDescription } from "../components/ui/alert";
import { notify } from "../lib/notify";
import { StackPortWordmark } from "../logo/StackPortBrand";

// ── Shared UI helpers ─────────────────────────────────────────────────────────

function formatBytes(bytes: number | null): string {
  if (bytes == null) return "unknown";
  const gb = bytes / (1024 * 1024 * 1024);
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

function StateBadge({ state }: { state: string }) {
  const s = state.toLowerCase();
  const tone = s === "running" ? styles.stateRunning : s === "exited" || s === "dead" ? styles.stateStopped : s === "paused" ? styles.statePaused : styles.stateUnknown;
  return <span className={cn(styles.stateDot, tone)} title={state} />;
}

function OutputBlock({ output, ok, onDismiss }: { output: string; ok: boolean; onDismiss: () => void }) {
  return (
    <div className={styles.outputShell}>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className={styles.outputDismiss}
        onClick={onDismiss}
        title="Dismiss"
      >
        <X size={12} />
      </Button>
      <pre className={cn("output-block", styles.outputBlock, !ok && "output-stderr")}>
        {output || "(no output)"}
      </pre>
    </div>
  );
}

function SystemSkeleton() {
  return (
    <div className={styles.skeletonGrid}>
      <div className={styles.skeletonCard}>
        <div className={styles.skeletonLine} />
        <div className={styles.skeletonLineShort} />
        <div className={styles.skeletonBlock} />
      </div>
      <div className={styles.skeletonCard}>
        <div className={styles.skeletonLine} />
        <div className={styles.skeletonLineShort} />
        <div className={styles.skeletonRows}>
          <span />
          <span />
          <span />
        </div>
      </div>
    </div>
  );
}

// ── Container mini-table ──────────────────────────────────────────────────────

function ContainerTable({ containers }: { containers: ContainerInfo[] }) {
  const [loadingLogsId, setLoadingLogsId] = useState<string | null>(null);
  const [logsResult, setLogsResult] = useState<{ container: ContainerInfo; lines: number; ok: boolean; output: string } | null>(null);
  const [shellContainer, setShellContainer] = useState<ContainerInfo | null>(null);
  const [logStreamContainer, setLogStreamContainer] = useState<ContainerInfo | null>(null);

  async function viewLogs(container: ContainerInfo) {
    setLoadingLogsId(container.id);
    try {
      const result = await api.getDockerContainerLogs(container.id);
      setLogsResult({
        container,
        lines: result.lines,
        ok: result.ok,
        output: result.output,
      });
      if (!result.ok) {
        notify.error(new Error(result.output), `Failed to read ${container.name} logs`);
      }
    } catch (err) {
      notify.error(err, `Failed to read ${container.name} logs`);
    } finally {
      setLoadingLogsId(null);
    }
  }

  if (containers.length === 0) return <div className={styles.compactEmpty}>No containers.</div>;
  return (
    <>
      <Table className={styles.containerTable}>
        <TableHeader>
          <TableRow>
            <TableHead>State</TableHead>
            <TableHead>Service / Name</TableHead>
            <TableHead>Image</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>CPU%</TableHead>
            <TableHead>Mem</TableHead>
            <TableHead>Mem%</TableHead>
            <TableHead>Ports</TableHead>
            <TableHead className={styles.actionsHead}>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {containers.map((c) => (
            <TableRow key={c.id} className={cn(c.state !== "running" && styles.dimmedRow)}>
              <TableCell>
                <StateBadge state={c.state} />
                <span className="mono" style={{ fontSize: "0.9em" }}>{c.state}</span>
              </TableCell>
              <TableCell>
                <span className="mono">{c.service ?? c.name}</span>
                {c.service && (
                  <span style={{ color: "var(--dim)", fontSize: "0.8em", marginLeft: 4 }}>({c.name})</span>
                )}
              </TableCell>
              <TableCell className="mono">{c.image}</TableCell>
              <TableCell>{c.status}</TableCell>
              <TableCell className="mono">{c.stats?.cpu ?? "—"}</TableCell>
              <TableCell className="mono">{c.stats?.mem ?? "—"}</TableCell>
              <TableCell className="mono">{c.stats?.memPerc ?? "—"}</TableCell>
              <TableCell className={cn("mono", styles.portsCell)}>
                {c.ports || "—"}
              </TableCell>
              <TableCell>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => void viewLogs(c)}
                  disabled={loadingLogsId !== null}
                  title={`View ${c.name} logs`}
                  aria-label={`View ${c.name} logs`}
                >
                  {loadingLogsId === c.id ? <Loader size={12} className="spin" /> : <FileText size={12} />}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => setShellContainer(c)}
                  disabled={c.state !== "running"}
                  title={c.state === "running" ? `Open shell in ${c.name}` : "Container must be running to open a shell"}
                  aria-label={`Open shell in ${c.name}`}
                >
                  <SquareTerminal size={12} />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => setLogStreamContainer(c)}
                  title={`Live logs for ${c.name}`}
                  aria-label={`Live logs for ${c.name}`}
                >
                  <Radio size={12} />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {logsResult && (
        <div className={styles.containerLogs}>
          <div className={styles.resultHeader}>
            <FileText size={12} />
            <span className="mono">{logsResult.container.service ?? logsResult.container.name}</span>
            <span className="muted-text">last {logsResult.lines} lines</span>
          </div>
          <OutputBlock
            output={logsResult.output}
            ok={logsResult.ok}
            onDismiss={() => setLogsResult(null)}
          />
        </div>
      )}
      {shellContainer && (
        <ContainerShellDialog container={shellContainer} onClose={() => setShellContainer(null)} />
      )}
      {logStreamContainer && (
        <ContainerLogDialog container={logStreamContainer} onClose={() => setLogStreamContainer(null)} />
      )}
    </>
  );
}

// ── Compose stack row ─────────────────────────────────────────────────────────

type ComposeOp = "up" | "down" | "build";
type CertbotOp = "issue" | "renew" | "delete";
type SystemTab = "nginx" | "docker" | "certbot" | "github" | "firewall";

const STACK_COLLAPSE_KEY = "stackport_system_collapsed_stacks";
const NGINX_DOC_KEY = "stackport_system_nginx_doc";

function readCollapsedStacks(): Record<string, boolean> {
  try {
    const value = localStorage.getItem(STACK_COLLAPSE_KEY);
    return value ? JSON.parse(value) as Record<string, boolean> : {};
  } catch {
    return {};
  }
}

function isSystemTab(value: string): value is SystemTab {
  return value === "docker" || value === "nginx" || value === "certbot" || value === "github" || value === "firewall";
}

function readNginxDocumentKind(): NginxDocumentKind {
  try {
    const value = localStorage.getItem(NGINX_DOC_KEY);
    if (value === "generated" || value === "failed" || value === "general" || value === "project") return value;
    if (value === "fixed") return "general";
    if (value === "domain") return "project";
    return "generated";
  } catch {
    return "generated";
  }
}

function certbotStatusLabel(entry: CertbotEntry): [string, string] {
  if (!entry.hasCertificate) return ["valid", "missing"];
  if (entry.status === "expired") return ["valid", "expired"];
  if (entry.status === "expiring") return ["expiring", "missing"];
  if (entry.status === "unknown") return ["valid", "unknown"];
  return ["valid", "missing"];
}

function certbotStatusOk(entry: CertbotEntry): boolean {
  return entry.hasCertificate && entry.status !== "expired" && entry.status !== "unknown";
}

interface StackRowProps {
  stack: ComposeStack;
  onAction: (stack: string, action: ComposeOp) => Promise<void>;
  activeOp: ComposeOp | null;
  result: { ok: boolean; output: string } | null;
  onDismissResult: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

function StackRow({ stack, onAction, activeOp, result, onDismissResult, collapsed, onToggleCollapsed }: StackRowProps) {
  const busy = activeOp !== null;
  const open = !collapsed;

  const runningCount = stack.containers.filter((c) => c.state === "running").length;
  const totalCount = stack.containers.length;
  const allRunning = totalCount > 0 && runningCount === totalCount;
  const anyRunning = runningCount > 0;

  return (
    <Card className={styles.stackCard}>
      <CardHeader className={styles.stackHeader}>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={onToggleCollapsed}
          title={open ? "Collapse" : "Expand"}
        >
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </Button>

        <CardTitle className={cn("mono", styles.stackTitle)}>{stack.name}</CardTitle>

        <StatusChip ok={allRunning} labels={[`${runningCount}/${totalCount} running`, anyRunning ? `${runningCount}/${totalCount} running` : "stopped"]} />

        {stack.configFiles[0] && (
          <span className={cn("mono", styles.stackPath)}>
            {stack.configFiles[0]}
          </span>
        )}

        <div className={cn("row-actions", styles.stackActions)}>
          <Button
            type="button"
            variant="outline"
            size="xs"
            className={styles.successButton}
            onClick={() => void onAction(stack.name, "up")}
            disabled={busy}
            title="docker compose up"
          >
            {activeOp === "up" ? <Loader size={12} className="spin" /> : <Play size={12} />}
            Up
          </Button>
          <Button
            type="button"
            variant="outline"
            size="xs"
            className={styles.dangerButton}
            onClick={() => void onAction(stack.name, "down")}
            disabled={busy}
            title="docker compose stop"
          >
            {activeOp === "down" ? <Loader size={12} className="spin" /> : <Square size={12} />}
            Down
          </Button>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => void onAction(stack.name, "build")}
            disabled={busy}
            title="docker compose build"
          >
            {activeOp === "build" ? <Loader size={12} className="spin" /> : <Hammer size={12} />}
            Build
          </Button>
        </div>
      </CardHeader>

      {result && (
        <CardContent className={styles.stackResult}>
          <OutputBlock output={result.output} ok={result.ok} onDismiss={onDismissResult} />
        </CardContent>
      )}

      {open && (
        <CardContent className={styles.stackBody}>
          <ContainerTable containers={stack.containers} />
        </CardContent>
      )}
    </Card>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function System() {
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    system: data, vps: vpsData, refreshSystem: refresh, refreshVps,
    applyNginx, updateNginxAppConfig, certbotAction, pruneDockerCache,
  } = useSystem();
  const loading = data === null;
  const [collapsedStacks, setCollapsedStacks] = useState<Record<string, boolean>>(() => readCollapsedStacks());
  const [activeTab, setActiveTab] = useState<SystemTab>(() => {
    const tab = searchParams.get("tab");
    return tab && isSystemTab(tab) ? tab : "nginx";
  });
  const [nginxDocKind, setNginxDocKind] = useState<NginxDocumentKind>(() => readNginxDocumentKind());
  const [nginxRoutesOpen, setNginxRoutesOpen] = useState(false);
  const [nginxFilesOpen, setNginxFilesOpen] = useState(false);
  const [nginxDoc, setNginxDoc] = useState<NginxDocument | null>(null);
  const [nginxDocDraft, setNginxDocDraft] = useState("");
  const [loadingNginxDoc, setLoadingNginxDoc] = useState(false);
  const [savingNginxDoc, setSavingNginxDoc] = useState(false);
  const [nginxDocResult, setNginxDocResult] = useState<{ ok: boolean; output: string } | null>(null);

  // Per-stack action state: { [stackName]: { op, result } }
  const [stackOps, setStackOps] = useState<Record<string, { op: ComposeOp | null; result: { ok: boolean; output: string } | null }>>({});
  const [certbotOps, setCertbotOps] = useState<Record<string, { op: CertbotOp | null; result: { ok: boolean; output: string } | null }>>({});

  // Nginx reload state
  const [reloading, setReloading] = useState(false);
  const [applyingNginx, setApplyingNginx] = useState(false);
  const [reloadResult, setReloadResult] = useState<{ ok: boolean; output: string } | null>(null);
  const [installingTool, setInstallingTool] = useState<"nginx" | "certbot" | null>(null);
  const [installResult, setInstallResult] = useState<{ ok: boolean; output: string } | null>(null);
  const [certbotEmailDraft, setCertbotEmailDraft] = useState("");
  const [certbotEmailDirty, setCertbotEmailDirty] = useState(false);
  const [savingCertbotEmail, setSavingCertbotEmail] = useState(false);
  const [certbotEmailResult, setCertbotEmailResult] = useState<{ ok: boolean; output: string } | null>(null);
  const [nginxAppEnabledDraft, setNginxAppEnabledDraft] = useState(false);
  const [nginxAppDomainDraft, setNginxAppDomainDraft] = useState("");
  const [nginxAppUseSslDraft, setNginxAppUseSslDraft] = useState(true);
  const [nginxAppDirty, setNginxAppDirty] = useState(false);
  const [savingNginxApp, setSavingNginxApp] = useState(false);
  const [pruningDocker, setPruningDocker] = useState(false);
  const [dockerPruneResult, setDockerPruneResult] = useState<{ ok: boolean; output: string } | null>(null);
  const [storageThresholdsDraft, setStorageThresholdsDraft] = useState<DockerStorageThresholds | null>(null);
  const [storageThresholdsDirty, setStorageThresholdsDirty] = useState(false);
  const [savingStorageThresholds, setSavingStorageThresholds] = useState(false);
  const [nginxRuntimeDraft, setNginxRuntimeDraft] = useState<"host" | "container">("host");
  const [nginxRuntimeDirty, setNginxRuntimeDirty] = useState(false);
  const [savingNginxRuntime, setSavingNginxRuntime] = useState(false);

  // GitHub Poller state
  const [ghConfig, setGhConfig] = useState<GitHubPollerConfig | null>(null);
  const [ghCredentialIdDraft, setGhCredentialIdDraft] = useState<number | null>(null);
  const [ghIntervalDraft, setGhIntervalDraft] = useState("300");
  const [ghEnabledDraft, setGhEnabledDraft] = useState(false);
  const [savingGh, setSavingGh] = useState(false);
  const [pollingGh, setPollingGh] = useState(false);
  const [loadingGhConfig, setLoadingGhConfig] = useState(false);
  const [ghCredentials, setGhCredentials] = useState<Credential[]>([]);
  const [ghPollOutputOpen, setGhPollOutputOpen] = useState(false);

  // Firewall state
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

  const docker = data?.docker;
  const nginx = data?.nginx;
  const certbot = data?.certbot;
  const dockerStacks = docker?.stacks ?? [];
  const standaloneContainers = docker?.standalone ?? [];
  const dockerDiskUsage = docker?.diskUsage ?? [];
  const dockerStorage = docker?.storage ?? null;
  const dockerHasRunningContainers = [...dockerStacks.flatMap((stack) => stack.containers), ...standaloneContainers]
    .some((container) => container.state === "running");
  const nginxSelectorOk = !!nginx?.available && !!nginx.active;
  const dockerSelectorOk = !!docker?.available && dockerHasRunningContainers;
  const certbotSelectorOk = !!certbot?.available;
  const firewallSelectorOk = providerFirewalls.length > 0 || firewallProfiles.length > 0;
  const selectorIconClass = (ok: boolean) => cn(styles.selectorIcon, !loading && (ok ? styles.selectorIconOk : styles.selectorIconFail));
  const vpsProviders = vpsData?.providers ?? [];
  const monitoredVms = vpsData?.monitored ?? [];
  const selectedFirewallProfile = firewallProfiles.find((profile) => profile.id === selectedFirewallProfileId) ?? firewallProfiles[0] ?? null;
  const firewallMonitoredVms = monitoredVms.filter((vm) => vm.providerId === firewallProviderId);
  const nginxAppChanged = nginxAppDirty && (
    !nginx?.layer?.app ||
    nginxAppEnabledDraft !== nginx.layer.app.enabled ||
    nginxAppDomainDraft !== nginx.layer.app.domain ||
    nginxAppUseSslDraft !== nginx.layer.app.useSsl
  );
  const nginxAppDomain = nginx?.layer?.app.domain ?? "";
  const nginxAppCertEntry = certbot?.entries.find((entry) => entry.domain === nginxAppDomain) ?? null;
  const nginxAppCertState = nginxAppDomain ? certbotOps[nginxAppDomain] ?? { op: null, result: null } : { op: null, result: null };
  const nginxAppCertBusy = nginxAppCertState.op !== null;

  useEffect(() => {
    localStorage.setItem(STACK_COLLAPSE_KEY, JSON.stringify(collapsedStacks));
  }, [collapsedStacks]);

  useEffect(() => {
    const tab = searchParams.get("tab");
    if (tab && isSystemTab(tab) && tab !== activeTab) {
      setActiveTab(tab);
    }
  }, [searchParams, activeTab]);

  useEffect(() => {
    localStorage.setItem(NGINX_DOC_KEY, nginxDocKind);
  }, [nginxDocKind]);

  useEffect(() => {
    if (activeTab !== "nginx") return;
    if (!nginxFilesOpen) return;
    void loadNginxDocument(nginxDocKind);
  }, [activeTab, nginxDocKind, nginxFilesOpen]);

  useEffect(() => {
    if (nginxDocKind === "failed" && nginx?.layer && !nginx.layer.failedConfigExists) {
      setNginxDocKind("generated");
    }
  }, [nginx?.layer, nginxDocKind]);

  useEffect(() => {
    if (certbotEmailDirty) return;
    setCertbotEmailDraft(data?.certbot.email ?? "");
  }, [data?.certbot.email, certbotEmailDirty]);

  useEffect(() => {
    if (nginxAppChanged) return;
    if (!nginx?.layer?.app) return;
    setNginxAppEnabledDraft(nginx.layer.app.enabled);
    setNginxAppDomainDraft(nginx.layer.app.domain);
    setNginxAppUseSslDraft(nginx.layer.app.useSsl);
    setNginxAppDirty(false);
  }, [nginx?.layer?.app, nginxAppChanged]);

  useEffect(() => {
    api.getDockerStorageThresholds()
      .then((result) => setStorageThresholdsDraft(result))
      .catch(() => {});
  }, []);

  useEffect(() => {
    api.getNginxRuntime()
      .then((result) => setNginxRuntimeDraft(result.runtime))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (activeTab !== "github") return;
    if (ghConfig) return;
    setLoadingGhConfig(true);
    Promise.all([api.getGithubPollerConfig(), api.listCredentials()])
      .then(([cfg, creds]) => {
        setGhConfig(cfg);
        setGhEnabledDraft(cfg.enabled);
        setGhIntervalDraft(String(cfg.pollIntervalS));
        setGhCredentialIdDraft(cfg.credentialId);
        setGhCredentials(creds.filter((c) => c.type === "github"));
      })
      .catch(() => {})
      .finally(() => setLoadingGhConfig(false));
  }, [activeTab, ghConfig]);

  useEffect(() => {
    if (firewallProviderId === "" && vpsProviders.length > 0) {
      setFirewallProviderId(vpsProviders[0].id);
    }
  }, [firewallProviderId, vpsProviders]);

  useEffect(() => {
    if (activeTab !== "firewall") return;
    if (firewallProviderId === "") return;
    void refreshFirewallData(firewallProviderId);
  }, [activeTab, firewallProviderId]);

  useEffect(() => {
    if (selectedFirewallProfile && selectedFirewallProfileId === "") {
      setSelectedFirewallProfileId(selectedFirewallProfile.id);
    }
  }, [selectedFirewallProfile, selectedFirewallProfileId]);

  function syncGhConfig(cfg: GitHubPollerConfig) {
    setGhConfig(cfg);
    setGhEnabledDraft(cfg.enabled);
    setGhIntervalDraft(String(cfg.pollIntervalS));
    setGhCredentialIdDraft(cfg.credentialId);
  }

  async function handleGhSave() {
    const toastId = notify.loading("Saving GitHub poller config...");
    setSavingGh(true);
    try {
      const cfg = await api.updateGithubPollerConfig({
        enabled: ghEnabledDraft,
        credentialId: ghCredentialIdDraft,
        pollIntervalS: Number(ghIntervalDraft) || 300,
      });
      syncGhConfig(cfg);
      notify.success("GitHub poller config saved.", { id: toastId });
    } catch (err) {
      notify.error(err, "Failed to save GitHub poller config", { id: toastId });
    } finally {
      setSavingGh(false);
    }
  }

  async function handleGhPollNow() {
    const toastId = notify.loading("Triggering GitHub poll...");
    setPollingGh(true);
    setGhPollOutputOpen(false);
    try {
      await api.triggerGithubPoll();
      notify.success("GitHub poll triggered.", { id: toastId });
      setTimeout(() => {
        api.getGithubPollerConfig().then(syncGhConfig).catch(() => {});
      }, 3000);
    } catch (err) {
      notify.error(err, "Failed to trigger GitHub poll", { id: toastId });
    } finally {
      setPollingGh(false);
    }
  }

  function handleSystemTabChange(value: string) {
    if (!isSystemTab(value)) return;
    setActiveTab(value);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("tab", value);
      return next;
    }, { replace: true });
  }

  async function loadNginxDocument(kind: NginxDocumentKind = nginxDocKind) {
    setLoadingNginxDoc(true);
    setNginxDocResult(null);
    try {
      const document = await api.getNginxDocument(kind);
      setNginxDoc(document);
      setNginxDocDraft(document.content);
    } catch (err) {
      setNginxDocResult({ ok: false, output: err instanceof ApiError ? err.message : "Failed to load nginx file" });
    } finally {
      setLoadingNginxDoc(false);
    }
  }

  async function saveNginxTemplate() {
    if (nginxDocKind !== "general" && nginxDocKind !== "project") return;
    const toastId = notify.loading(`Saving ${nginxDocKind} template...`);
    setSavingNginxDoc(true);
    setApplyingNginx(true);
    setNginxDocResult(null);
    setReloadResult(null);
    try {
      const document = await api.updateNginxTemplate(nginxDocKind, nginxDocDraft);
      setNginxDoc(document);
      setNginxDocDraft(document.content);
      notify.success(`Saved ${document.path}.`, { id: toastId });
      const final = await applyNginx();
      const ok = final?.ok ?? false;
      setNginxDocResult({ ok, output: `Saved ${document.path}` });
      setReloadResult({ ok, output: [`saved: ${document.path}`, final?.log ?? ""].filter(Boolean).join("\n") });
      refresh();
      void loadNginxDocument("generated");
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Failed to save nginx template";
      setNginxDocResult({ ok: false, output: msg });
      notify.error(err, "Failed to save nginx template", { id: toastId });
    } finally {
      setSavingNginxDoc(false);
      setApplyingNginx(false);
    }
  }

  async function handleComposeAction(stackName: string, action: ComposeOp) {
    const toastId = notify.loading(`${stackName}: docker compose ${action}...`);
    setStackOps((prev) => ({ ...prev, [stackName]: { op: action, result: null } }));
    try {
      const result = await api.composeAction(stackName, action);
      setStackOps((prev) => ({ ...prev, [stackName]: { op: null, result } }));
      if (result.ok) {
        notify.success(`${stackName}: ${action} completed.`, { id: toastId });
      } else {
        notify.error(new Error(result.output || `${action} failed`), `${stackName}: ${action} failed`, { id: toastId });
      }
      // After up/down, refresh docker data silently
      if (action !== "build") refresh();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Action failed";
      setStackOps((prev) => ({ ...prev, [stackName]: { op: null, result: { ok: false, output: msg } } }));
      notify.error(err, `${stackName}: ${action} failed`, { id: toastId });
    }
  }

  function dismissResult(stackName: string) {
    setStackOps((prev) => ({ ...prev, [stackName]: { ...(prev[stackName] ?? { op: null }), result: null } }));
  }

  function toggleStackCollapsed(stackName: string) {
    setCollapsedStacks((prev) => ({ ...prev, [stackName]: !prev[stackName] }));
  }

  async function handleCertbotAction(domain: string, action: CertbotOp) {
    setCertbotOps((prev) => ({ ...prev, [domain]: { op: action, result: null } }));
    const final = await certbotAction(domain, action);
    const result = final ? { ok: final.ok ?? false, output: final.log } : { ok: false, output: "Certbot action failed" };
    setCertbotOps((prev) => ({ ...prev, [domain]: { op: null, result } }));
    refresh();
  }

  function dismissCertbotResult(domain: string) {
    setCertbotOps((prev) => ({ ...prev, [domain]: { ...(prev[domain] ?? { op: null }), result: null } }));
  }

  async function handleCertbotEmailSave() {
    const toastId = notify.loading("Saving certbot email...");
    setSavingCertbotEmail(true);
    setCertbotEmailResult(null);
    try {
      const result = await api.updateCertbotEmail(certbotEmailDraft);
      setCertbotEmailDraft(result.email);
      setCertbotEmailDirty(false);
      setCertbotEmailResult({
        ok: true,
        output: result.emailConfigured ? "Certbot email saved." : "Certbot email cleared.",
      });
      notify.success(result.emailConfigured ? "Certbot email saved." : "Certbot email cleared.", { id: toastId });
      refresh();
    } catch (err) {
      setCertbotEmailResult({ ok: false, output: err instanceof ApiError ? err.message : "Failed to save certbot email" });
      notify.error(err, "Failed to save certbot email", { id: toastId });
    } finally {
      setSavingCertbotEmail(false);
    }
  }

  async function handleNginxReload() {
    const toastId = notify.loading("Reloading nginx...");
    setReloading(true);
    setReloadResult(null);
    try {
      const result = await api.reloadNginx();
      setReloadResult(result);
      if (result.ok) {
        notify.success("Nginx reloaded.", { id: toastId });
        refresh();
      } else {
        notify.error(new Error(result.output || "Reload failed"), "Nginx reload failed", { id: toastId });
      }
    } catch (err) {
      setReloadResult({ ok: false, output: err instanceof ApiError ? err.message : "Reload failed" });
      notify.error(err, "Nginx reload failed", { id: toastId });
    } finally {
      setReloading(false);
    }
  }

  async function handleNginxApply() {
    setApplyingNginx(true);
    setReloadResult(null);
    try {
      const final = await applyNginx();
      setReloadResult(final ? { ok: final.ok ?? false, output: final.log } : { ok: false, output: "Apply failed" });
      refresh();
      if (nginxDocKind === "generated") void loadNginxDocument("generated");
    } finally {
      setApplyingNginx(false);
    }
  }

  async function handleDockerPrune() {
    setPruningDocker(true);
    setDockerPruneResult(null);
    try {
      const final = await pruneDockerCache();
      setDockerPruneResult(final ? { ok: final.ok ?? false, output: final.log } : { ok: false, output: "Prune failed" });
      refresh();
    } finally {
      setPruningDocker(false);
    }
  }

  async function handleNginxAppSave() {
    setSavingNginxApp(true);
    setReloadResult(null);
    try {
      const final = await updateNginxAppConfig({
        enabled: nginxAppEnabledDraft,
        domain: nginxAppDomainDraft,
        useSsl: nginxAppUseSslDraft,
      });
      const app = final?.meta?.["app"] as NginxAppConfig | undefined;
      if (app) {
        setNginxAppEnabledDraft(app.enabled);
        setNginxAppDomainDraft(app.domain);
        setNginxAppUseSslDraft(app.useSsl);
        setNginxAppDirty(false);
      }
      const ok = final?.ok ?? false;
      setReloadResult({
        ok,
        output: [
          `app domain: ${app?.domain || "none"}`,
          `app port: ${app?.port ?? "-"}`,
          `enabled: ${app?.enabled ? "yes" : "no"}`,
          `ssl: ${app?.useSsl ? "yes" : "no"}`,
          final?.log ?? "",
        ].filter(Boolean).join("\n"),
      });
      refresh();
    } finally {
      setSavingNginxApp(false);
    }
  }

  async function handleStorageThresholdsSave() {
    if (!storageThresholdsDraft) return;
    setSavingStorageThresholds(true);
    try {
      const result = await api.updateDockerStorageThresholds(storageThresholdsDraft);
      setStorageThresholdsDraft(result);
      setStorageThresholdsDirty(false);
      notify.success("Storage thresholds updated");
    } catch (err) {
      notify.error(err, "Failed to update storage thresholds");
    } finally {
      setSavingStorageThresholds(false);
    }
  }

  async function handleNginxRuntimeSave() {
    setSavingNginxRuntime(true);
    try {
      const result = await api.updateNginxRuntime(nginxRuntimeDraft);
      setNginxRuntimeDraft(result.runtime);
      setNginxRuntimeDirty(false);
      notify.success(result.runtime === "container" ? "Switched to the containerized nginx" : "Switched back to host nginx");
    } catch (err) {
      notify.error(err, "Failed to update nginx runtime");
    } finally {
      setSavingNginxRuntime(false);
    }
  }

  async function handleInstallTool(tool: "nginx" | "certbot") {
    const toastId = notify.loading(`Installing ${tool}...`);
    setInstallingTool(tool);
    setInstallResult(null);
    try {
      const result = await api.installSystemTool(tool);
      setInstallResult({ ok: result.ok, output: result.output });
      if (result.ok) {
        notify.success(`${tool} installed.`, { id: toastId });
      } else {
        notify.error(new Error(result.output || `Failed to install ${tool}`), `Failed to install ${tool}`, { id: toastId });
      }
      refresh();
    } catch (err) {
      setInstallResult({ ok: false, output: err instanceof ApiError ? err.message : `Failed to install ${tool}` });
      notify.error(err, `Failed to install ${tool}`, { id: toastId });
    } finally {
      setInstallingTool(null);
    }
  }

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

  const certbotEmailForm = (
    <>
      <div className={styles.certbotEmailPanel}>
        <div className="field field-wide">
          <label htmlFor="certbot-email">
            <Mail size={12} />
            Certificate email
          </label>
          <Input
            id="certbot-email"
            type="email"
            className={styles.formInput}
            value={certbotEmailDraft}
            placeholder="admin@example.com"
            onChange={(event) => {
              setCertbotEmailDraft(event.target.value);
              setCertbotEmailDirty(true);
            }}
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() => void handleCertbotEmailSave()}
          disabled={savingCertbotEmail || certbotEmailDraft.trim() === (certbot?.email ?? "")}
          title="Save certbot email"
        >
          {savingCertbotEmail ? <Loader size={12} className="spin" /> : <Save size={12} />}
          Save
        </Button>
      </div>
      {certbotEmailResult && (
        <OutputBlock
          output={certbotEmailResult.output}
          ok={certbotEmailResult.ok}
          onDismiss={() => setCertbotEmailResult(null)}
        />
      )}
    </>
  );

  const dockerPanel = (
    <>
      <div className={styles.sectionTitle}>
        <Box size={14} />
        Docker
        {docker?.version && (
          <span className={cn("mono", styles.titleMeta)}>
            v{docker.version}
          </span>
        )}
        <span className={styles.titleStatus}>
          <StatusChip ok={!!docker?.available} labels={["available", "unavailable"]} />
        </span>
      </div>

      {!docker?.available ? (
        <Alert className={styles.softAlert}>
          <AlertCircle size={14} />
          <AlertDescription>{docker?.reason ?? "Not available"}</AlertDescription>
        </Alert>
      ) : (
        <>
          <div className={styles.dockerDfPanel}>
            <div className={cn(styles.sectionTitle, styles.subsectionTitle)} style={{ marginTop: 0 }}>
              <span>Disk usage</span>
              <div className={cn("row-actions", styles.titleActions)}>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => void handleDockerPrune()}
                  disabled={pruningDocker}
                  title="docker builder prune -a -f"
                >
                  {pruningDocker ? <Loader size={12} className="spin" /> : <Trash2 size={12} />}
                  Prune build cache
                </Button>
              </div>
            </div>
            <div className={styles.dockerDfBody}>
              {dockerDiskUsage.length === 0 ? (
                <div className={styles.dockerDfEmpty}>No disk usage data.</div>
              ) : (
                <div className={styles.dockerDfList}>
                  <div className={cn(styles.dockerDfRow, styles.dockerDfHead)}>
                    <span>Type</span>
                    <span>Count (active)</span>
                    <span>Size</span>
                    <span>Reclaimable</span>
                  </div>
                  {dockerDiskUsage.map((entry) => (
                    <div key={entry.type} className={styles.dockerDfRow}>
                      <span>{entry.type}</span>
                      <span>{entry.totalCount} ({entry.active})</span>
                      <span className="mono">{entry.size}</span>
                      <span className="mono">{entry.reclaimable}</span>
                    </div>
                  ))}
                </div>
              )}
              {dockerPruneResult && (
                <OutputBlock
                  output={dockerPruneResult.output}
                  ok={dockerPruneResult.ok}
                  onDismiss={() => setDockerPruneResult(null)}
                />
              )}
            </div>
          </div>

          {dockerStorage && (
            <div className={styles.dockerDfPanel}>
              <div className={cn(styles.sectionTitle, styles.subsectionTitle)} style={{ marginTop: 0 }}>
                <span>Storage pressure</span>
              </div>
              {dockerStorage.state !== "unknown" && (
                <div className="muted-text" style={{ marginBottom: 8 }}>
                  {formatBytes(dockerStorage.freeBytes)} free
                  {dockerStorage.totalBytes != null && ` of ${formatBytes(dockerStorage.totalBytes)}`}
                  {" — "}
                  <strong
                    style={{
                      color: dockerStorage.state === "critical"
                        ? "var(--danger)"
                        : dockerStorage.state === "warning"
                          ? "var(--brand)"
                          : undefined,
                    }}
                  >
                    {dockerStorage.state}
                  </strong>
                </div>
              )}
              {dockerStorage.state === "critical" && (
                <Alert className={styles.softAlert}>
                  <AlertCircle size={14} />
                  <AlertDescription>
                    New builds are blocked until space is freed — an automatic build-cache cleanup runs first, and
                    the build only proceeds if that frees up enough room.
                  </AlertDescription>
                </Alert>
              )}
              {storageThresholdsDraft && (
                <div className="row-actions" style={{ alignItems: "flex-end", flexWrap: "wrap", gap: 12, marginTop: 8 }}>
                  <div className="field" style={{ maxWidth: 160 }}>
                    <label>Warning below</label>
                    <Input
                      type="number"
                      min={0}
                      step={0.5}
                      value={(storageThresholdsDraft.warningFreeBytes / (1024 * 1024 * 1024)).toFixed(1)}
                      onChange={(e) => {
                        const gb = Number(e.target.value);
                        if (!Number.isFinite(gb)) return;
                        setStorageThresholdsDraft({ ...storageThresholdsDraft, warningFreeBytes: Math.round(gb * 1024 * 1024 * 1024) });
                        setStorageThresholdsDirty(true);
                      }}
                    />
                    <span className="hint">GB free</span>
                  </div>
                  <div className="field" style={{ maxWidth: 160 }}>
                    <label>Critical below</label>
                    <Input
                      type="number"
                      min={0}
                      step={0.5}
                      value={(storageThresholdsDraft.criticalFreeBytes / (1024 * 1024 * 1024)).toFixed(1)}
                      onChange={(e) => {
                        const gb = Number(e.target.value);
                        if (!Number.isFinite(gb)) return;
                        setStorageThresholdsDraft({ ...storageThresholdsDraft, criticalFreeBytes: Math.round(gb * 1024 * 1024 * 1024) });
                        setStorageThresholdsDirty(true);
                      }}
                    />
                    <span className="hint">GB free</span>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => void handleStorageThresholdsSave()}
                    disabled={savingStorageThresholds || !storageThresholdsDirty}
                  >
                    {savingStorageThresholds ? <Loader size={12} className="spin" /> : <Save size={12} />}
                    Save
                  </Button>
                </div>
              )}
            </div>
          )}

          {dockerStacks.length === 0 && standaloneContainers.length === 0 && (
            <div className="empty">No containers found.</div>
          )}

          {dockerStacks.map((stack) => {
            const state = stackOps[stack.name] ?? { op: null, result: null };
            return (
              <StackRow
                key={stack.name}
                stack={stack}
                onAction={handleComposeAction}
                activeOp={state.op}
                result={state.result}
                onDismissResult={() => dismissResult(stack.name)}
                collapsed={!!collapsedStacks[stack.name]}
                onToggleCollapsed={() => toggleStackCollapsed(stack.name)}
              />
            );
          })}

          {standaloneContainers.length > 0 && (
            <>
              <div className={cn(styles.sectionTitle, styles.subsectionTitle)}>
                <Layers size={12} />Standalone containers
              </div>
              <ContainerTable containers={standaloneContainers} />
            </>
          )}
        </>
      )}
    </>
  );

  const nginxPanel = (
    <>
      <div className={styles.sectionTitle}>
        <Layers size={13} />
        Nginx
        {nginx?.version && (
          <span className={cn("mono", styles.titleMeta)}>
            {nginx.version}
          </span>
        )}
        {nginx?.available !== undefined && (
          <span>
            <StatusChip ok={!!nginx.available} labels={["installed", "not installed"]} />
          </span>
        )}
        {nginx?.available && nginx.active !== undefined && (
          <span>
            <StatusChip ok={nginx.active} labels={["active", "inactive"]} />
          </span>
        )}
        {nginx?.available && (
          <div className={cn("row-actions", styles.titleActions)}>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => void handleNginxApply()}
              disabled={applyingNginx || reloading}
              title="Generate, validate, and reload"
            >
              {applyingNginx ? <Loader size={12} className="spin" /> : <FileText size={12} />}
              Apply
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => void handleNginxReload()}
              disabled={reloading || applyingNginx}
              title="Regenerate and reload nginx"
            >
              {reloading ? <Loader size={12} className="spin" /> : <RotateCw size={12} />}
              Reload
            </Button>
          </div>
        )}
      </div>

      <div className={styles.nginxAppPanel}>
        <div className={styles.nginxAppHeader}>
          <label className={styles.nginxAppSwitch}>
            <Switch
              checked={nginxRuntimeDraft === "container"}
              onCheckedChange={(checked) => {
                setNginxRuntimeDraft(checked ? "container" : "host");
                setNginxRuntimeDirty(true);
              }}
            />
            <span>
              <span>Use containerized Nginx and Certbot</span>
              <span>
                Enabled by default for VPS installations. Nginx runs continuously in Docker;
                Certbot runs in temporary containers when issuing or renewing certificates.
              </span>
            </span>
          </label>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => void handleNginxRuntimeSave()}
            disabled={savingNginxRuntime || !nginxRuntimeDirty}
          >
            {savingNginxRuntime ? <Loader size={12} className="spin" /> : <Save size={12} />}
            Save
          </Button>
        </div>
      </div>

      {!nginx?.available ? (
        <div>
          <Alert className={styles.softAlert}>
            <AlertCircle size={14} />
            <AlertDescription>{nginx?.reason ?? "Not available"}</AlertDescription>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => void handleInstallTool("nginx")}
              disabled={installingTool !== null}
              title="Try to install nginx"
            >
              {installingTool === "nginx" ? <Loader size={12} className="spin" /> : <Download size={12} />}
              Install
            </Button>
          </Alert>
          {installResult && (
            <OutputBlock
              output={installResult.output}
              ok={installResult.ok}
              onDismiss={() => setInstallResult(null)}
            />
          )}
        </div>
      ) : (
        <>
          {nginx.layer && (
            <>
              <div className={styles.nginxMetaGrid}>
                <div>
                  <div className="muted-text">Layer</div>
                  <span className="mono path-text">Real nginx</span>
                </div>
                <div>
                  <div className="muted-text">Generated file</div>
                  <span className="mono path-text">{nginx.layer.targetPath}</span>
                </div>
                <div>
                  <div className="muted-text">General config</div>
                  <span className="mono path-text">{nginx.layer.generalTemplatePath ?? nginx.layer.fixedBlockPath}</span>
                </div>
                <div>
                  <div className="muted-text">Project template</div>
                  <span className="mono path-text">{nginx.layer.projectTemplatePath ?? nginx.layer.domainTemplatePath}</span>
                </div>
                <div>
                  <div className="muted-text">Backups</div>
                  <span className="mono path-text">{nginx.layer.backupCount} in {nginx.layer.backupDir}</span>
                </div>
                <div>
                  <div className="muted-text">All routed hosts</div>
                  <span className="mono path-text">
                    {nginx.layer.domains.length > 0 ? nginx.layer.domains.join(", ") : "none"}
                  </span>
                </div>
                <div>
                  <div className="muted-text">Domain list</div>
                  <span className="mono path-text">
                    {nginx.layer.domainList.length > 0 ? nginx.layer.domainList.join(", ") : "none"}
                  </span>
                </div>
                <div>
                  <div className="muted-text">Subdomain list</div>
                  <span className="mono path-text">
                    {nginx.layer.subdomainList.length > 0 ? nginx.layer.subdomainList.join(", ") : "none"}
                  </span>
                </div>
              </div>

              <div className={styles.nginxAppPanel}>
                <div className={styles.nginxAppHeader}>
                  <label className={styles.nginxAppSwitch}>
                    <Switch
                      checked={nginxAppEnabledDraft}
                      onCheckedChange={(checked) => {
                        setNginxAppEnabledDraft(checked);
                        setNginxAppDirty(true);
                      }}
                    />
                    <span>
                      <span>Publish <StackPortWordmark className={styles.inlineBrand} /> through Nginx</span>
                      <span>Uses the backend port inferred from this server. While enabled, projects cannot use that port.</span>
                    </span>
                  </label>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => void handleNginxAppSave()}
                    disabled={savingNginxApp || !nginxAppChanged || (nginxAppEnabledDraft && !nginxAppDomainDraft.trim())}
                  >
                    {savingNginxApp ? <Loader size={12} className="spin" /> : <Save size={12} />}
                    Save
                  </Button>
                </div>
                <div className={styles.nginxAppFields}>
                  <div className="field field-wide">
                    <label>App domain</label>
                    <Input
                      type="text"
                      placeholder="vps.example.com"
                      value={nginxAppDomainDraft}
                      onChange={(event) => {
                        setNginxAppDomainDraft(event.target.value);
                        setNginxAppDirty(true);
                      }}
                    />
                  </div>
                  <div>
                    <div className="muted-text">Inferred app port</div>
                    <span className="mono path-text">{nginx.layer.app.port}</span>
                  </div>
                </div>
                <div className={styles.nginxAppFields}>
                  <label className={styles.nginxAppSwitch}>
                    <Switch
                      checked={nginxAppUseSslDraft}
                      onCheckedChange={(checked) => {
                        setNginxAppUseSslDraft(checked);
                        setNginxAppDirty(true);
                      }}
                    />
                    <span>
                      <span>Use HTTPS for <StackPortWordmark /></span>
                      <span>When a certificate exists, nginx serves the app over HTTPS and redirects HTTP.</span>
                    </span>
                  </label>
                  {nginx.layer.app.enabled && nginx.layer.app.domain && nginx.layer.app.useSsl && (
                    <div className={cn("row-actions", styles.certbotActions)}>
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        onClick={() => void handleCertbotAction(nginx.layer!.app.domain, "issue")}
                        disabled={nginxAppCertBusy || !certbot?.emailConfigured}
                        title={certbot?.emailConfigured ? "Issue app certificate" : "Save a certbot email first"}
                      >
                        {nginxAppCertState.op === "issue" ? <Loader size={12} className="spin" /> : <KeyRound size={12} />}
                        Issue cert
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        onClick={() => void handleCertbotAction(nginx.layer!.app.domain, "renew")}
                        disabled={nginxAppCertBusy || !nginxAppCertEntry?.hasCertificate}
                        title="Renew app certificate"
                      >
                        {nginxAppCertState.op === "renew" ? <Loader size={12} className="spin" /> : <RotateCw size={12} />}
                        Renew
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        className={styles.dangerButton}
                        onClick={() => void handleCertbotAction(nginx.layer!.app.domain, "delete")}
                        disabled={nginxAppCertBusy || !nginxAppCertEntry?.hasCertificate}
                        title="Delete app certificate"
                      >
                        {nginxAppCertState.op === "delete" ? <Loader size={12} className="spin" /> : <Trash2 size={12} />}
                        Delete
                      </Button>
                    </div>
                  )}
                </div>
                {nginxAppCertEntry && (
                  <div className={styles.certbotMeta}>
                    <span className="mono path-text">cert: {nginxAppCertEntry.status}</span>
                    <span className="mono path-text">expires: {formatShortDateTime(nginxAppCertEntry.expiresAt, "not issued")}</span>
                  </div>
                )}
                {nginxAppCertState.result && (
                  <div className={styles.certbotResult}>
                    <OutputBlock
                      output={nginxAppCertState.result.output}
                      ok={nginxAppCertState.result.ok}
                      onDismiss={() => dismissCertbotResult(nginx.layer!.app.domain)}
                    />
                  </div>
                )}
              </div>

              <div className={styles.nginxRouteSummary}>
                <button
                  type="button"
                  className={styles.collapsibleTrigger}
                  onClick={() => setNginxRoutesOpen((open) => !open)}
                  aria-expanded={nginxRoutesOpen}
                >
                  {nginxRoutesOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  <span className={styles.collapsibleTitle}>Published routes</span>
                  <span className={styles.collapsibleMeta}>{nginx.layer.routes.length}</span>
                </button>
                {nginxRoutesOpen && (
                  <div className={styles.nginxRouteBody}>
                    {nginx.layer.routes.length === 0 ? (
                      <div className={styles.nginxRouteEmpty}>No routes are currently published through Nginx.</div>
                    ) : (
                      <div className={styles.nginxRouteList}>
                        {nginx.layer.routes.map((route) => (
                          <div className={styles.nginxRouteRow} key={`${route.project}:${route.domain}:${route.port}`}>
                            <span className="mono">{route.project}</span>
                            <span className="mono path-text">{route.domain}</span>
                            <span className="mono">{route.service}:{route.port}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}

          <div className={styles.nginxDocPanel}>
            <button
              type="button"
              className={styles.collapsibleTrigger}
              onClick={() => setNginxFilesOpen((open) => !open)}
              aria-expanded={nginxFilesOpen}
            >
              {nginxFilesOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              <span className={styles.collapsibleTitle}>Nginx files</span>
              <span className={styles.collapsibleMeta}>{nginxDocKind}</span>
            </button>

            {nginxFilesOpen && (
              <div className={styles.nginxDocBody}>
                <div className={styles.nginxDocHeader}>
                  <Tabs value={nginxDocKind} onValueChange={(value) => setNginxDocKind(value as NginxDocumentKind)}>
                    <TabsList className={styles.nginxDocTabs}>
                      <TabsTrigger value="generated" title="Inspect generated sites-available/default">
                        <Eye size={12} />
                        Generated
                      </TabsTrigger>
                      {nginx.layer?.failedConfigExists && (
                        <TabsTrigger
                          value="failed"
                          className={styles.failedDocTab}
                          title="Inspect the last generated config that failed validation or reload"
                        >
                          <AlertCircle size={12} />
                          Failed
                        </TabsTrigger>
                      )}
                      <TabsTrigger value="general" title="Edit the general config template">
                        <Settings size={12} />
                        General
                      </TabsTrigger>
                      <TabsTrigger value="project" title="Edit the per-project block template">
                        <FileText size={12} />
                        Project
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>

                  <div className="row-actions">
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={() => void loadNginxDocument()}
                      disabled={loadingNginxDoc}
                      title="Reload file content"
                    >
                      {loadingNginxDoc ? <Loader size={12} className="spin" /> : <RefreshCw size={12} />}
                      Reload
                    </Button>
                    {nginxDoc?.editable && (
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        onClick={() => void saveNginxTemplate()}
                        disabled={savingNginxDoc || nginxDocDraft === nginxDoc.content}
                        title="Save template"
                      >
                        {savingNginxDoc ? <Loader size={12} className="spin" /> : <Save size={12} />}
                        Save
                      </Button>
                    )}
                  </div>
                </div>

                <div className={styles.nginxDocMeta}>
                  <span className="mono path-text">{nginxDoc?.path ?? "No file loaded"}</span>
                  {nginxDoc?.sizeBytes != null && <span className="mono">{nginxDoc.sizeBytes} bytes</span>}
                  {nginxDoc?.updatedAt && <span className="mono">{formatShortDateTime(nginxDoc.updatedAt)}</span>}
                </div>

                {loadingNginxDoc ? (
                  <div className="empty" style={{ padding: 18 }}>
                    <Loader size={16} className="spin" />
                  </div>
                ) : nginxDoc?.editable ? (
                  <NginxCode
                    value={nginxDocDraft}
                    mode="editable"
                    onChange={setNginxDocDraft}
                  />
                ) : (
                  <NginxCode value={nginxDocDraft} mode="view" />
                )}

                {nginxDocResult && (
                  <OutputBlock
                    output={nginxDocResult.output}
                    ok={nginxDocResult.ok}
                    onDismiss={() => setNginxDocResult(null)}
                  />
                )}
              </div>
            )}
          </div>

          {nginx.configTest && (
            <div>
              <div className={styles.resultHeader}>
                <span>Config test</span>
                <StatusChip ok={nginx.configTest.ok} labels={["OK", "FAILED"]} />
              </div>
              {nginx.configTest.output && (
                <pre className="output-block" style={{ fontSize: "0.78em" }}>
                  {nginx.configTest.output}
                </pre>
              )}
            </div>
          )}
          {reloadResult && (
            <div className={styles.resultPanel}>
              <OutputBlock
                output={reloadResult.output}
                ok={reloadResult.ok}
                onDismiss={() => setReloadResult(null)}
              />
            </div>
          )}
          {nginx.layer?.lastOperation && (
            <div className={styles.resultPanel}>
              <div className={styles.resultHeader}>
                <span>Last apply</span>
                <StatusChip ok={nginx.layer.lastOperation.ok} labels={["OK", "FAILED"]} />
                <span className="mono">
                  {formatShortDateTime(nginx.layer.lastOperation.updatedAt)} | restarts {nginx.layer.lastOperation.restartCount}
                </span>
              </div>
              <pre className={`output-block${nginx.layer.lastOperation.ok ? "" : " output-stderr"}`} style={{ fontSize: "0.76em" }}>
                {nginx.layer.lastOperation.output || "(no output)"}
              </pre>
            </div>
          )}
        </>
      )}
    </>
  );

  const certbotPanel = (
    <>
      <div className={styles.sectionTitle}>
        <ShieldCheck size={13} />
        Certbot
        {certbot && (
          <span className={cn("mono", styles.titleMeta)}>
            real
          </span>
        )}
        {certbot && (
          <span>
            <StatusChip ok={certbot.available} labels={["available", "unavailable"]} />
          </span>
        )}
        {certbot?.available && (
          <div className={cn(styles.titleActions, styles.inlineMeta, "muted-text")}>
            <span className="mono path-text">{certbot.rootPath}</span>
            <span className="mono">{certbot.emailConfigured ? "email configured" : "no email"}</span>
          </div>
        )}
      </div>

      {!certbot?.available ? (
        <div>
          <Alert className={styles.softAlert}>
            <AlertCircle size={14} />
            <AlertDescription>{certbot?.reason ?? "Certbot status unavailable"}</AlertDescription>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => void handleInstallTool("certbot")}
              disabled={installingTool !== null}
              title="Try to install certbot"
            >
              {installingTool === "certbot" ? <Loader size={12} className="spin" /> : <Download size={12} />}
              Install
            </Button>
          </Alert>
          {installResult && (
            <OutputBlock
              output={installResult.output}
              ok={installResult.ok}
              onDismiss={() => setInstallResult(null)}
            />
          )}
        </div>
      ) : certbot.entries.length === 0 ? (
        <>
          {certbotEmailForm}
          <div className={styles.panelEmpty}>No routed domains.</div>
        </>
      ) : (
        <>
          {certbotEmailForm}
          <div className={styles.certbotList}>
            {certbot.entries.map((entry) => {
              const state = certbotOps[entry.domain] ?? { op: null, result: null };
              const busy = state.op !== null;
              const expires = formatShortDateTime(entry.expiresAt, "not issued");
              return (
                <div className={styles.certbotRow} key={entry.domain}>
                  <div className={styles.certbotMain}>
                    <div className={styles.certbotHost}>
                      {entry.hasCertificate ? <ShieldCheck size={14} /> : <ShieldX size={14} />}
                      <span className="mono path-text">{entry.domain}</span>
                      <span className="badge">{entry.type}</span>
                      <StatusChip ok={certbotStatusOk(entry)} labels={certbotStatusLabel(entry)} />
                    </div>
                    <div className={styles.certbotMeta}>
                      <span className="mono path-text">expires: {expires}</span>
                      {entry.issuer && <span className="mono path-text">issuer: {entry.issuer}</span>}
                      {entry.path && <span className="mono path-text">path: {entry.path}</span>}
                    </div>
                  </div>

                  <div className={cn("row-actions", styles.certbotActions)}>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={() => void handleCertbotAction(entry.domain, "issue")}
                      disabled={busy || !certbot.emailConfigured}
                      title={certbot.emailConfigured ? "Issue certificate" : "Save a certbot email first"}
                    >
                      {state.op === "issue" ? <Loader size={12} className="spin" /> : <KeyRound size={12} />}
                      Issue
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={() => void handleCertbotAction(entry.domain, "renew")}
                      disabled={busy || !entry.hasCertificate}
                      title="Renew certificate"
                    >
                      {state.op === "renew" ? <Loader size={12} className="spin" /> : <RotateCw size={12} />}
                      Renew
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      className={styles.dangerButton}
                      onClick={() => void handleCertbotAction(entry.domain, "delete")}
                      disabled={busy || !entry.hasCertificate}
                      title="Delete certificate"
                    >
                      {state.op === "delete" ? <Loader size={12} className="spin" /> : <Trash2 size={12} />}
                      Delete
                    </Button>
                  </div>

                  {state.result && (
                    <div className={styles.certbotResult}>
                      <OutputBlock
                        output={state.result.output}
                        ok={state.result.ok}
                        onDismiss={() => dismissCertbotResult(entry.domain)}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </>
  );

  const POLL_INTERVALS = [
    { label: "1 min", value: "60" },
    { label: "5 min", value: "300" },
    { label: "15 min", value: "900" },
    { label: "30 min", value: "1800" },
    { label: "1 hour", value: "3600" },
  ];

  const ghChanged = ghConfig ? (
    ghEnabledDraft !== ghConfig.enabled ||
    ghCredentialIdDraft !== ghConfig.credentialId ||
    ghIntervalDraft !== String(ghConfig.pollIntervalS)
  ) : true;

  const ghPanel = (
    <>
      <div className={styles.sectionTitle}>
        <GitBranch size={14} />
        GitHub Poller
        {ghConfig && (
          <span className={cn(styles.titleMeta, "mono")} style={{ fontSize: "0.78rem" }}>
            {ghConfig.enabled ? "enabled" : "disabled"}
          </span>
        )}
        <div className={cn("row-actions", styles.titleActions)}>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => void handleGhPollNow()}
            disabled={pollingGh || loadingGhConfig || !ghConfig?.enabled}
            title={ghConfig?.enabled ? "Trigger a poll now" : "Enable poller first"}
          >
            {pollingGh ? <Loader size={12} className="spin" /> : <RefreshCw size={12} />}
            Poll now
          </Button>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => void handleGhSave()}
            disabled={savingGh || loadingGhConfig || !ghChanged}
          >
            {savingGh ? <Loader size={12} className="spin" /> : <Save size={12} />}
            Save
          </Button>
        </div>
      </div>

      {loadingGhConfig ? (
        <div className={styles.loadingState} style={{ padding: 32 }}>
          <Loader size={18} className="spin" />
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", gap: 20, alignItems: "flex-end", flexWrap: "wrap" }}>
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 500, fontSize: "0.85rem", cursor: "pointer" }}>
              <Switch
                checked={ghEnabledDraft}
                onCheckedChange={(v) => setGhEnabledDraft(v)}
              />
              {ghEnabledDraft ? "Enabled" : "Disabled"}
            </label>

            <div className="field" style={{ margin: 0 }}>
              <label>Poll interval</label>
              <AppSelect
                value={ghIntervalDraft}
                onValueChange={setGhIntervalDraft}
                options={POLL_INTERVALS.map((opt) => ({ value: opt.value, label: opt.label }))}
              />
            </div>

            <div className="field" style={{ margin: 0, minWidth: 200 }}>
              <label>
                <KeyRound size={12} />
                GitHub credential
              </label>
              <GitHubTokenSelect
                credentials={ghCredentials}
                value={ghCredentialIdDraft}
                onValueChange={setGhCredentialIdDraft}
                placeholder="None (public repos only)"
                noneLabel="None (public repos only)"
              />
              {ghCredentials.length === 0 && (
                <div style={{ fontSize: "0.75rem", color: "var(--dim)", marginTop: 3 }}>
                  Add a GitHub credential in the Credentials page first.
                </div>
              )}
            </div>
          </div>

          {ghConfig && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: "0.82rem" }}>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", color: "var(--dim)" }}>
                <span>Last poll: <span className="mono">{formatShortDateTime(ghConfig.lastPolledAt, "never")}</span></span>
                {ghConfig.lastError && (
                  <span style={{ color: "var(--danger)" }}>Error: {ghConfig.lastError}</span>
                )}
              </div>

              {ghConfig.lastPollOutput && (
                <div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ fontSize: "0.78rem", padding: "2px 6px" }}
                    onClick={() => setGhPollOutputOpen((v) => !v)}
                  >
                    {ghPollOutputOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                    Last poll output
                  </button>
                  {ghPollOutputOpen && (
                    <div className={styles.outputShell} style={{ marginTop: 6 }}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className={styles.outputDismiss}
                        onClick={() => setGhPollOutputOpen(false)}
                        title="Collapse"
                      >
                        <X size={12} />
                      </Button>
                      <pre className={cn("output-block", styles.outputBlock, !!ghConfig.lastError && "output-stderr")}>
                        {ghConfig.lastPollOutput}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );

  const firewallPanel = (
    <>
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
        <SystemSkeleton />
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
    </>
  );

  return (
    <>
      <main className="main">
        <div className="page-header">
          <h1 className="page-title">
            <Cpu size={20} />System
          </h1>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={refresh}
            disabled={loading}
          >
            <RefreshCw size={13} />
            Refresh
          </Button>
        </div>

          <Tabs value={activeTab} onValueChange={handleSystemTabChange} className={styles.pageTabs}>
            <TabsList className={styles.pageTabsList}>
              <TabsTrigger value="nginx">
                <Layers size={13} className={selectorIconClass(nginxSelectorOk)} />
                Nginx
              </TabsTrigger>
              <TabsTrigger value="docker">
                <Box size={13} className={selectorIconClass(dockerSelectorOk)} />
                Docker
              </TabsTrigger>
              <TabsTrigger value="certbot">
                <ShieldCheck size={13} className={selectorIconClass(certbotSelectorOk)} />
                Certbot
              </TabsTrigger>
              <TabsTrigger value="github">
                <GitBranch size={13} />
                GitHub
              </TabsTrigger>
              <TabsTrigger value="firewall">
                <Shield size={13} className={selectorIconClass(firewallSelectorOk)} />
                Firewall
              </TabsTrigger>
            </TabsList>

            <TabsContent value="nginx">
              <section className={styles.systemPanel}>{loading ? <SystemSkeleton /> : nginxPanel}</section>
            </TabsContent>

            <TabsContent value="docker">
              <section className={styles.systemPanel}>{loading ? <SystemSkeleton /> : dockerPanel}</section>
            </TabsContent>

            <TabsContent value="certbot">
              <section className={styles.systemPanel}>{loading ? <SystemSkeleton /> : certbotPanel}</section>
            </TabsContent>

            <TabsContent value="github">
              <section className={styles.systemPanel}>{loading ? <SystemSkeleton /> : ghPanel}</section>
            </TabsContent>

            <TabsContent value="firewall">
              <section className={styles.systemPanel}>{firewallPanel}</section>
            </TabsContent>
          </Tabs>
      </main>
    </>
  );
}
