import { lazy, Suspense, useState, useEffect } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import {
  Cpu, RefreshCw, Loader, Box, Layers, AlertCircle,
  RotateCw, Play, Square, Hammer, ChevronDown, ChevronRight, X, FileText, Save, Eye, Settings,
  ShieldCheck, ShieldX, KeyRound, Trash2, Mail,
  SquareTerminal, Radio,
} from "lucide-react";
import NginxCode from "../components/NginxCode";
// The terminal dialogs pull in xterm (~90 KB gzipped); load it only when one opens.
const ContainerShellDialog = lazy(() => import("../components/ContainerShellDialog").then((m) => ({ default: m.ContainerShellDialog })));
const ContainerLogDialog = lazy(() => import("../components/ContainerLogDialog").then((m) => ({ default: m.ContainerLogDialog })));
import { StatusChip } from "../components/StatusChip";
import { ServiceError } from "../components/ServiceError";
import { api, ApiError } from "../api/client";
import type {
  ComposeStack,
  ContainerInfo,
  NginxAppConfig,
  NginxDocument,
  NginxDocumentKind,
  CertbotEntry,
  DockerStorageThresholds,
} from "../api/types";
import { useSystem } from "../context/SystemContext";
import { formatShortDateTime } from "../lib/format";
import { cn } from "../lib/utils";
import styles from "./System.module.scss";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/tabs";
import { Button } from "../components/ui/button";
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
        <Suspense fallback={null}>
          <ContainerShellDialog container={shellContainer} onClose={() => setShellContainer(null)} />
        </Suspense>
      )}
      {logStreamContainer && (
        <Suspense fallback={null}>
          <ContainerLogDialog container={logStreamContainer} onClose={() => setLogStreamContainer(null)} />
        </Suspense>
      )}
    </>
  );
}

// ── Compose stack row ─────────────────────────────────────────────────────────

type ComposeOp = "up" | "down" | "build";
type CertbotOp = "issue" | "renew" | "delete";
type SystemTab = "nginx" | "docker" | "certbot";

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
  return value === "docker" || value === "nginx" || value === "certbot";
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

/** The poller and firewall moved to Settings; keep old /system?tab= links working. */
export default function System() {
  const [searchParams] = useSearchParams();
  const tab = searchParams.get("tab");
  if (tab === "github") return <Navigate to="/settings/deploy-triggers" replace />;
  if (tab === "firewall") return <Navigate to="/settings/infrastructure" replace />;
  return <SystemPage />;
}

function SystemPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    system: data, refreshSystem: refresh,
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
  const selectorIconClass = (ok: boolean) => cn(styles.selectorIcon, !loading && (ok ? styles.selectorIconOk : styles.selectorIconFail));
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
        <ServiceError service="Docker" reason={docker?.reason} className={styles.softAlert} />
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
            <StatusChip ok={!!nginx.available} labels={["available", "unavailable"]} />
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

      <p className="muted-text">Nginx runs in the stackport-nginx container. Certbot uses temporary Docker containers for certificate issuance and renewal.</p>

      {!nginx?.available ? (
        <div>
          <ServiceError service="Nginx" reason={nginx?.reason} className={styles.softAlert} />
        </div>
      ) : (
        <>
          {nginx.layer && (
            <>
              <div className={styles.nginxMetaGrid}>
                <div>
                  <div className="muted-text">Layer</div>
                  <span className="mono path-text">Docker Nginx</span>
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
            Docker
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
          <ServiceError service="Certbot" reason={certbot?.reason} className={styles.softAlert} />
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

          </Tabs>
      </main>
    </>
  );
}
