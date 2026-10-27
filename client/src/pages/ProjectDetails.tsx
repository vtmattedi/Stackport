import { lazy, memo, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft, Box, EllipsisVertical, ExternalLink, FileText, FolderDot, GitBranch,
  Hammer, Loader, Pause, Play, Plus, RefreshCw, Save, ScrollText, Square, Trash2, Upload, X, GitCommit, Activity, Zap, FlameKindling,
  SquareTerminal, Radio, KeyRound, AlertTriangle, ChevronRight, Rocket, Globe,
} from "lucide-react";
import { ActionSelect, AppSelect } from "../components/AppSelect";
import { DeployTriggerControl } from "../components/DeployTriggerControl";
import { ServiceError } from "../components/ServiceError";
import { ProjectGroupField } from "../components/ProjectGroupField";
import { ProjectIngressSelect } from "../components/ProjectIngressSelect";
import { GitHubTokenSelect } from "../components/GitHubTokenSelect";
import { ExpandableCard } from "../components/ExpandableCard";
import { ProjectResourceCharts as ProjectResourceChartsBase } from "../components/ProjectResourceCharts";
// The terminal dialogs pull in xterm (~90 KB gzipped); load it only when one opens.
const ContainerShellDialog = lazy(() => import("../components/ContainerShellDialog").then((m) => ({ default: m.ContainerShellDialog })));
const ContainerLogDialog = lazy(() => import("../components/ContainerLogDialog").then((m) => ({ default: m.ContainerLogDialog })));
import { ComposeFileDialog } from "../components/ComposeFileDialog";
import { EnvManagerDialog } from "../components/EnvManagerDialog";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/ui/tooltip";
import { useConfirm } from "../components/ConfirmDialog";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { NumberInput } from "../components/NumberInput";
import { api, ApiError } from "../api/client";
import type {
  ActionRecord,
  ContainerInfo,
  Credential,
  Project,
  ProjectActionsSnapshot,
  ProjectDeployEvent,
  ProjectDomain,
  TcpExposure,
  ProjectEnvFile,
  ProjectResourceData,
  ProjectResourceSampleEvent,
  ProjectUpdateEvent,
  GitHubBranch,
  ProjectDeploy,
  ProjectDeploymentRevision,
} from "../api/types";
import { useSocket } from "../context/SocketContext";
import { jsonEqual, pollProjectAction, useSystemActions, useSystemSelector } from "../context/SystemContext";
import { formatShortDateTime, formatTimeAgo } from "../lib/format";
import { parseAnsi } from "../lib/ansi";
import { deriveProjectStatus, expectedComposeProjectName, explainProjectStatus, findProjectStack, healthMonitoredContainers, projectStatusLabel, type ProjectStatusKind } from "../lib/projectStatus";
import { cn } from "../lib/utils";
import { notify } from "../lib/notify";
import styles from "./ProjectDetails.module.scss";
import { TimeAgo } from "../components/TimeAgo";
import { ActionResult, createLogStore, type FinishedAction } from "./project/ActionLog";
import { DeploymentsCard } from "./project/DeploymentsCard";
import { DomainRow, TcpExposureRow } from "./project/IngressRows";

const INTERVALS = [
  { label: "Off", value: 0 },
  { label: "30 s", value: 30 },
  { label: "1 min", value: 60 },
  { label: "5 min", value: 300 },
  { label: "15 min", value: 900 },
  { label: "30 min", value: 1800 },
  { label: "1 hr", value: 3600 },
];

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className={styles.detailRow}>
      <span className="muted-text">{label}</span>
      <span>{value}</span>
    </div>
  );
}

/** A collapsible group inside the Project Config form; open state is remembered per section. */
function ConfigSection({
  title,
  actions,
  storageKey,
  defaultOpen = true,
  children,
}: {
  title: string;
  actions?: ReactNode;
  storageKey: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const key = `stackport:config-section:${storageKey}`;
  const [open, setOpen] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? defaultOpen : stored === "1";
    } catch {
      return defaultOpen;
    }
  });
  function toggle() {
    setOpen(!open);
    try {
      localStorage.setItem(key, open ? "0" : "1");
    } catch {
      // storage unavailable — state just won't persist
    }
  }
  return (
    <div className={cn(styles.runtimeSection, !open && styles.runtimeSectionCollapsed)}>
      <div className={styles.runtimeSectionHeader}>
        <button type="button" className={styles.sectionToggle} onClick={toggle} aria-expanded={open}>
          <ChevronRight size={12} className={cn(styles.sectionChevron, open && styles.sectionChevronOpen)} />
          {title}
        </button>
        {actions}
      </div>
      {open && children}
    </div>
  );
}

// Recharts redraws its SVG on every render; only redraw when the samples change.
const ProjectResourceCharts = memo(ProjectResourceChartsBase);

/** Owns its own live samples (every ~15 s) so they re-render this card, not the page.
 *  The charts get `history`, which only changes when a 5-minute bucket closes. */
function ResourceUsageCard({ projectId }: { projectId: number }) {
  const { on, off } = useSocket();
  const [history, setHistory] = useState<ProjectResourceData | null>(null);
  const [latest, setLatest] = useState<ProjectResourceData["latest"]>(null);

  // Latest cpu/mem/net numbers arrive live over WS the instant the sampler writes
  // them (see project:resource-sample) — no more independent client poll timer
  // desynced from the sampler's own 15s interval. History is 5-minute-bucketed
  // server-side, so it's re-fetched only when a live sample crosses into a new
  // bucket (i.e. the previous bucket just became final), not on a fixed clock.
  useEffect(() => {
    if (!Number.isInteger(projectId) || projectId <= 0) return;
    let cancelled = false;
    let lastBucket: number | null = null;
    const refetch = () => {
      void api.getProjectResources(projectId, 24).then((data) => {
        if (!cancelled) { setHistory(data); setLatest(data.latest); }
      }).catch(() => { /* non-critical */ });
    };
    refetch();

    const handler = (event: ProjectResourceSampleEvent) => {
      if (event.projectId !== projectId) return;
      setLatest(event.sample);
      const bucket = Math.floor(new Date(event.sample.sampledAt).getTime() / (5 * 60_000));
      if (lastBucket !== null && bucket !== lastBucket) refetch();
      lastBucket = bucket;
    };
    on<ProjectResourceSampleEvent>("project:resource-sample", handler);
    return () => {
      cancelled = true;
      off<ProjectResourceSampleEvent>("project:resource-sample", handler);
    };
  }, [projectId, on, off]);

  return (
    <ExpandableCard
      icon={<Activity size={13} />}
      title="Resource usage"
      storageKey="project.resources"
      defaultOpen
      summary={(
        <span className="mono" style={{ fontSize: 12 }}>
          {latest
            ? `CPU ${latest.cpuPercent.toFixed(1)}% · Mem ${latest.memPercent.toFixed(1)}%`
            : "5-min avg, last 24h"}
        </span>
      )}
    >
      <div className={styles.detailGrid} style={{ marginBottom: 12 }}>
        <DetailRow label="CPU" value={latest ? `${latest.cpuPercent.toFixed(1)}%` : "—"} />
        <DetailRow
          label="Memory"
          value={latest
            ? `${latest.memPercent.toFixed(1)}% (${Math.round(latest.memUsedMb)} MB / ${Math.round(latest.memLimitMb)} MB)`
            : "—"}
        />
      </div>
      <ProjectResourceCharts resources={history} chartHeight={180} />
    </ExpandableCard>
  );
}

function sameProjectGroups(a: Project[] | null, b: Project[] | null): boolean {
  const key = (list: Project[] | null) => (list ?? []).map((p) => p.groupName ?? "").join("\u0000");
  return a === b || key(a) === key(b);
}

function statusPillClass(status: ProjectStatusKind, styles: Record<string, string>): string {
  if (status === "ready") return styles.statusReady;
  if (status === "down") return styles.statusDown;
  if (status === "problem") return styles.statusProblem;
  if (status === "paused") return styles.statusPaused;
  return styles.statusNotDeployed;
}

function containerStateClass(state: string): string {
  const s = state.toLowerCase();
  if (s === "running") return styles.dockerStateRunning;
  if (s === "exited" || s === "dead" || s === "created") return styles.dockerStateStopped;
  if (s === "paused") return styles.dockerStatePaused;
  return styles.dockerStateUnknown;
}

function DockerContainerRow({
  container,
  onOpenShell,
  onOpenLogs,
  onRedeploy,
  redeploying,
  redeployDisabled,
  onDropVolumes,
  droppingVolumes,
  dropVolumesDisabled,
}: {
  container: ContainerInfo;
  onOpenShell: (container: ContainerInfo) => void;
  onOpenLogs: (container: ContainerInfo) => void;
  /** Only passed when the stack has more than one container — redeploying/dropping
   *  volumes for "a single container" is meaningless (equivalent to the whole-stack
   *  actions already available) when there's just one. */
  onRedeploy?: (container: ContainerInfo) => void;
  redeploying: boolean;
  redeployDisabled: boolean;
  onDropVolumes?: (container: ContainerInfo) => void;
  droppingVolumes: boolean;
  dropVolumesDisabled: boolean;
}) {
  const name = container.service ?? container.name;
  return (
    <div className={styles.dockerContainerRow}>
      <span className={styles.dockerContainerName}>
        <span className={cn(styles.dockerStateDot, containerStateClass(container.state))} />
        <span className="mono">{name}</span>
        {container.healthCheckIgnored && (
          <span className="muted-text" style={{ fontSize: 10 }} title="Excluded from project health status by com.stackport.health.ignore=true">
            helper
          </span>
        )}
      </span>
      <span className="mono">{container.state}</span>
      <span className="path-text">{container.status}</span>
      <span className="mono path-text">{container.ports || "-"}</span>
      <span className={styles.dockerContainerActions}>
        {onRedeploy && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => onRedeploy(container)}
            disabled={redeployDisabled}
            title={`Redeploy ${name} (rebuild + restart just this container)`}
            aria-label={`Redeploy ${name}`}
          >
            {redeploying ? <Loader size={12} className="spin" /> : <RefreshCw size={12} />}
          </Button>
        )}
        {onDropVolumes && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => onDropVolumes(container)}
            disabled={dropVolumesDisabled}
            title={`Drop volumes for ${name} (deletes its persisted data)`}
            aria-label={`Drop volumes for ${name}`}
          >
            {droppingVolumes ? <Loader size={12} className="spin" /> : <Trash2 size={12} />}
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => onOpenShell(container)}
          disabled={container.state !== "running"}
          title={container.state === "running" ? `Open shell in ${container.name}` : "Container must be running to open a shell"}
          aria-label={`Open shell in ${container.name}`}
        >
          <SquareTerminal size={12} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => onOpenLogs(container)}
          title={`Live logs for ${container.name}`}
          aria-label={`Live logs for ${container.name}`}
        >
          <Radio size={12} />
        </Button>
      </span>
    </div>
  );
}


export default function ProjectDetails() {
  const { id } = useParams();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const {
    subscribeDeploy,
    unsubscribeDeploy,
    subscribeDeploySync,
    unsubscribeDeploySync,
    subscribeProject,
    unsubscribeProject,
  } = useSocket();
  const { refreshProjects, refreshSystem, startProjectAction, redeployProjectContainer, dropProjectServiceVolumes, certbotAction, issueProjectDomainSsl } = useSystemActions();
  const projectId = Number(id);
  const [project, setProject] = useState<Project | null>(null);
  const [domains, setDomains] = useState<ProjectDomain[]>([]);

  // Live system data arrives every few seconds. Each selector below picks only what
  // this page renders, so the page re-renders when that slice changes, not on every push.
  const systemLoaded = useSystemSelector((snap) => snap.system !== null);
  const docker = useSystemSelector((snap) => {
    const data = snap.system?.docker;
    if (!data) return null;
    const stack = data.available && project ? findProjectStack(project, data.stacks) : null;
    return {
      available: data.available,
      reason: data.reason ?? null,
      // Per-container CPU/RAM stats change on every push and aren't shown here.
      stack: stack ? { ...stack, containers: stack.containers.map((c) => ({ ...c, stats: null })) } : null,
    };
  }, jsonEqual);
  const domainNames = domains.map((d) => d.domain);
  const certbotInfo = useSystemSelector((snap) => {
    const certbot = snap.system?.certbot;
    return {
      available: !!(certbot?.available && certbot?.emailConfigured),
      entries: (certbot?.entries ?? []).filter((entry) => domainNames.includes(entry.domain)),
    };
  }, jsonEqual);
  const certbotRecords = useSystemSelector(
    (snap) => snap.systemActions.certbot.filter((entry) => domainNames.includes(entry.meta?.["domain"] as string)),
    jsonEqual,
  );
  // Only group names are used (for the group picker).
  const allProjects = useSystemSelector((snap) => snap.projects, sameProjectGroups);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [envFiles, setEnvFiles] = useState<ProjectEnvFile[]>([]);
  const [envManagerOpen, setEnvManagerOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [deploying, setDeploying] = useState(false);
  const [pullingRepo, setPullingRepo] = useState(false);
  const [pullBranch, setPullBranch] = useState("");
  const [composingProject, setComposingProject] = useState(false);
  const [recreatingProject, setRecreatingProject] = useState(false);
  const [forceRebuilding, setForceRebuilding] = useState(false);
  const [redeployingService, setRedeployingService] = useState<string | null>(null);
  const [droppingVolumesService, setDroppingVolumesService] = useState<string | null>(null);
  const [togglingProject, setTogglingProject] = useState(false);
  const [stoppingProject, setStoppingProject] = useState(false);
  const [purgingProject, setPurgingProject] = useState(false);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [reuploadOpen, setReuploadOpen] = useState(false);
  const [reuploadComposeFile, setReuploadComposeFile] = useState<File | null>(null);
  const [reuploadSupportFiles, setReuploadSupportFiles] = useState<{ file: File | null; path: string }[]>([]);
  const [logsService, setLogsService] = useState("");
  const [logsTail, setLogsTail] = useState(100);
  const [logsOutput, setLogsOutput] = useState<string | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [shellContainer, setShellContainer] = useState<ContainerInfo | null>(null);
  const [logStreamContainer, setLogStreamContainer] = useState<ContainerInfo | null>(null);
  const [deletingProject, setDeletingProject] = useState(false);
  const [checkingHealth, setCheckingHealth] = useState(false);
  const [deployOk, setDeployOk] = useState<boolean | null>(null);
  const [finishedAction, setFinishedAction] = useState<FinishedAction | null>(null);
  // The action log streams in chunk by chunk; it lives in a small store so only the
  // <DeployLog> panel re-renders per chunk, not the whole page.
  const [deployLog] = useState(createLogStore);
  const setDeployLog = deployLog.set;
  const runtimeChangedRef = useRef(false);
  const [configRepo, setConfigRepo] = useState("");
  const [configGroupName, setConfigGroupName] = useState("");
  const [configGithubCredentialId, setConfigGithubCredentialId] = useState<number | null>(null);
  const [newDomainInput, setNewDomainInput] = useState("");
  const [newDomainService, setNewDomainService] = useState("");
  const [newDomainPort, setNewDomainPort] = useState("");
  const [addingDomain, setAddingDomain] = useState(false);
  const [domainError, setDomainError] = useState("");
  const [tcpExposures, setTcpExposures] = useState<TcpExposure[]>([]);
  const [newTcpPublicPort, setNewTcpPublicPort] = useState("");
  const [newTcpService, setNewTcpService] = useState("");
  const [newTcpContainerPort, setNewTcpContainerPort] = useState("");
  const [addingTcpExposure, setAddingTcpExposure] = useState(false);
  const [tcpExposureError, setTcpExposureError] = useState("");
  const [configHealthEndpoint, setConfigHealthEndpoint] = useState("");
  const [configHealthDomainId, setConfigHealthDomainId] = useState<number | null>(null);
  const [configIntervalS, setConfigIntervalS] = useState(0);
  const [configComposeFile, setConfigComposeFile] = useState("");
  const [composeFileDialogOpen, setComposeFileDialogOpen] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [configError, setConfigError] = useState("");
  const [configAutoDeployBranch, setConfigAutoDeployBranch] = useState<string>("");
  const [branches, setBranches] = useState<GitHubBranch[]>([]);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [branchError, setBranchError] = useState("");
  const [deploys, setDeploys] = useState<ProjectDeploy[]>([]);
  const [loadingDeploys, setLoadingDeploys] = useState(false);
  const [revisions, setRevisions] = useState<ProjectDeploymentRevision[]>([]);
  const [rollingBack, setRollingBack] = useState(false);
  const [configNginxExtra, setConfigNginxExtra] = useState("");
  const [configNginxExtraBlocks, setConfigNginxExtraBlocks] = useState("");

  async function load() {
    if (!Number.isInteger(projectId) || projectId <= 0) {
      setError("Invalid project id");
      setLoading(false);
      return;
    }

    setError("");
    setLoading(true);
    try {
      const [projectData, credentialData, domainData, tcpExposureData, envFileData] = await Promise.all([
        api.getProject(projectId),
        api.listCredentials(),
        api.listProjectDomains(projectId),
        api.listTcpExposures(projectId),
        api.listProjectEnvFiles(projectId),
      ]);
      setProject(projectData);
      syncConfig(projectData);
      setDomains(domainData);
      setTcpExposures(tcpExposureData);
      setCredentials(credentialData);
      setEnvFiles(envFileData);
      void syncActions(projectId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load project");
    } finally {
      setLoading(false);
    }
  }

  /** Restore in-flight action state (spinners/log) after a page load or reconnect. */
  function applyRepoActionSnapshot(action: NonNullable<ProjectActionsSnapshot["repo"]>) {
    setDeployLog(action.log);
    if (action.status === "running") {
      if (action.kind === "pull") setPullingRepo(true);
      if (action.kind === "compose") setComposingProject(true);
      if (action.kind === "recreate") setRecreatingProject(true);
      if (action.kind === "force-rebuild") setForceRebuilding(true);
      if (action.kind === "deploy") setDeploying(true);
      if (action.kind === "stop") setStoppingProject(true);
      if (action.kind === "stop-purge") setPurgingProject(true);
      if (action.kind === "upload") setUploadingFiles(true);
      if (action.kind === "redeploy-service") setRedeployingService((action.meta?.["service"] as string | undefined) ?? null);
      if (action.kind === "drop-volumes") setDroppingVolumesService((action.meta?.["service"] as string | undefined) ?? null);
    } else {
      setDeployOk(action.ok);
      setFinishedAction({ kind: action.kind, ok: action.ok, at: action.completedAt });
    }
  }

  async function syncActions(targetProjectId: number) {
    try {
      const actions = await api.getProjectActions(targetProjectId);
      if (actions.repo) applyRepoActionSnapshot(actions.repo);
    } catch {
      // non-critical — live updates will still arrive over WS
    }
  }

  function syncConfig(projectData: Project) {
    setConfigRepo(projectData.githubRepo ?? "");
    setConfigGroupName(projectData.groupName ?? "");
    setConfigGithubCredentialId(projectData.githubCredentialId);
    setConfigComposeFile(projectData.composeFile ?? "");
    setConfigHealthEndpoint(projectData.healthCheckEndpoint ?? "");
    setConfigHealthDomainId(projectData.healthCheckDomainId);
    setConfigIntervalS(projectData.healthCheckIntervalS);
    setConfigAutoDeployBranch(projectData.autoDeployBranch ?? "");
    setConfigNginxExtra(projectData.nginxExtraConfig ?? "");
    setConfigNginxExtraBlocks(projectData.nginxExtraBlocks ?? "");
    // Sync cached branch list from project when available
    if (projectData.branches.length > 0) setBranches(projectData.branches);
  }

  async function loadBranches(refresh = true) {
    if (!project?.githubRepo) return;
    setLoadingBranches(true);
    setBranchError("");
    try {
      const data = await api.getProjectBranches(project.id, refresh);
      setBranches(data.branches);
      setConfigAutoDeployBranch((current) => current || data.autoDeployBranch || "");
    } catch (err) {
      setBranchError(err instanceof ApiError ? err.message : "Failed to load branches");
    } finally {
      setLoadingBranches(false);
    }
  }

  async function loadDeploys() {
    if (!project) return;
    setLoadingDeploys(true);
    try {
      const data = await api.getProjectDeploys(project.id);
      setDeploys(data);
    } catch {
      // non-critical
    } finally {
      setLoadingDeploys(false);
    }
  }

  async function loadRevisions() {
    if (!project) return;
    try {
      setRevisions(await api.getProjectDeploymentRevisions(project.id));
    } catch {
      // non-critical
    }
  }

  async function handleRollback() {
    if (!project) return;
    const ok = await confirm({
      title: "Roll back to the previous deployment?",
      description: "Checks out the previous successful revision's exact commit and compose file, then redeploys from it. The current deployment stays recorded in history.",
      confirmLabel: "Roll back",
      destructive: true,
    });
    if (!ok) return;
    setRollingBack(true);
    try {
      const final = await startProjectAction(project.id, "rollback");
      if (final?.ok) notify.success("Rolled back successfully.");
      else notify.error(new Error(final?.log || "Rollback failed"), "Rollback failed");
      void loadRevisions();
      refreshSystem();
    } finally {
      setRollingBack(false);
    }
  }

  async function runProjectCommand(action: "pull" | "compose" | "deploy" | "recreate" | "force-rebuild", opts?: { branch?: string }) {
    if (!project) return;
    if (action === "pull") setPullingRepo(true);
    if (action === "compose") setComposingProject(true);
    if (action === "recreate") setRecreatingProject(true);
    if (action === "force-rebuild") setForceRebuilding(true);
    if (action === "deploy") setDeploying(true);
    setDeployOk(null);
    setDeployLog("");
    const final = await startProjectAction(project.id, action, opts);
    if (action === "pull") setPullingRepo(false);
    if (action === "compose") setComposingProject(false);
    if (action === "recreate") setRecreatingProject(false);
    if (action === "force-rebuild") setForceRebuilding(false);
    if (action === "deploy") setDeploying(false);
    if (!final) {
      setDeployOk(false);
    } else if (final.status === "running") {
      applyRepoActionSnapshot(final);
    } else {
      setDeployLog(final.log);
      setDeployOk(final.ok);
    }
  }

  async function redeployService(service: string) {
    if (!project) return;
    setRedeployingService(service);
    setDeployOk(null);
    setDeployLog("");
    const final = await redeployProjectContainer(project.id, service);
    setRedeployingService(null);
    if (!final) {
      setDeployOk(false);
    } else if (final.status === "running") {
      applyRepoActionSnapshot(final);
    } else {
      setDeployLog(final.log);
      setDeployOk(final.ok);
    }
  }

  async function dropServiceVolumes(service: string) {
    if (!project) return;
    const ok = await confirm({
      title: `Drop volumes for ${service}?`,
      description: `This stops ${service} and permanently deletes every volume mounted into it — any data it persisted (e.g. a database's contents) is gone. This cannot be undone.`,
      confirmLabel: "Drop Volumes",
      destructive: true,
    });
    if (!ok) return;
    setDroppingVolumesService(service);
    setDeployOk(null);
    setDeployLog("");
    const final = await dropProjectServiceVolumes(project.id, service);
    setDroppingVolumesService(null);
    if (!final) {
      setDeployOk(false);
    } else if (final.status === "running") {
      applyRepoActionSnapshot(final);
    } else {
      setDeployLog(final.log);
      setDeployOk(final.ok);
    }
  }

  async function runReupload() {
    if (!project || !reuploadComposeFile) return;
    setUploadingFiles(true);
    setDeployOk(null);
    setDeployLog("");
    try {
      const supportFiles = reuploadSupportFiles
        .filter((f): f is { file: File; path: string } => f.file !== null && f.path.trim().length > 0)
        .map((f) => ({ file: f.file, path: f.path.trim() }));
      const started = await api.uploadProjectCompose(project.id, reuploadComposeFile, supportFiles);
      if (!started.started) {
        notify.error(new Error(started.error ?? "An action is already running"), "Failed to start upload");
        return;
      }
      const final = await pollProjectAction(project.id, "repo");
      if (!final) {
        setDeployOk(false);
      } else if (final.status === "running") {
        applyRepoActionSnapshot(final);
      } else {
        setDeployLog(final.log);
        setDeployOk(final.ok);
        if (final.ok) {
          setReuploadOpen(false);
          setReuploadComposeFile(null);
          setReuploadSupportFiles([]);
          notify.success(`${project.name} re-uploaded and deployed.`);
        }
      }
    } finally {
      setUploadingFiles(false);
    }
  }

  function addReuploadSupportFile() {
    setReuploadSupportFiles((files) => [...files, { file: null, path: "" }]);
  }

  function updateReuploadSupportFile(index: number, patch: Partial<{ file: File | null; path: string }>) {
    setReuploadSupportFiles((files) => files.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  }

  function removeReuploadSupportFile(index: number) {
    setReuploadSupportFiles((files) => files.filter((_, i) => i !== index));
  }

  async function triggerHealthCheck() {
    if (!project) return;
    setCheckingHealth(true);
    try {
      const updated = await api.checkProject(project.id);
      setProject(updated);
      if (!runtimeChangedRef.current) syncConfig(updated);
    } catch (err) {
      notify.error(err, "Health check failed");
    } finally {
      setCheckingHealth(false);
    }
  }

  async function toggleProjectPaused() {
    if (!project) return;
    const toastId = notify.loading(project.paused ? `Starting ${project.name}...` : `Pausing ${project.name}...`);
    setTogglingProject(true);
    try {
      const updated = project.paused
        ? await api.resumeProject(project.id)
        : await api.pauseProject(project.id);
      setProject(updated);
      if (!runtimeChangedRef.current) syncConfig(updated);
      notify.success(project.paused ? `${project.name} started.` : `${project.name} paused.`, { id: toastId });
      refreshSystem();
    } catch (err) {
      notify.error(err, project.paused ? `Failed to start ${project.name}` : `Failed to pause ${project.name}`, { id: toastId });
    } finally {
      setTogglingProject(false);
    }
  }

  async function stopCurrentProject() {
    if (!project) return;
    const ok = await confirm({
      title: `Stop ${project.name}?`,
      description: "This runs docker compose down for the project repository.",
      confirmLabel: "Stop",
      destructive: true,
    });
    if (!ok) return;
    setStoppingProject(true);
    setDeployOk(null);
    setDeployLog("");
    const final = await startProjectAction(project.id, "stop");
    setStoppingProject(false);
    if (!final) {
      setDeployOk(false);
    } else if (final.status === "running") {
      applyRepoActionSnapshot(final);
    } else {
      setDeployLog(final.log);
      setDeployOk(final.ok);
    }
  }

  async function fetchDockerLogs() {
    if (!project) return;
    setLogsLoading(true);
    try {
      const result = await api.getProjectLogs(project.id, logsTail, logsService || undefined);
      setLogsOutput(result.output || "(no output)");
    } catch (err) {
      setLogsOutput(`Error: ${err instanceof ApiError ? err.message : "Failed to fetch logs"}`);
    } finally {
      setLogsLoading(false);
    }
  }

  async function stopAndPurgeCurrentProject() {
    if (!project) return;
    const ok = await confirm({
      title: `Delete all data for ${project.name}?`,
      description: "This runs docker compose down -v — all containers, networks, and volumes for this project will be permanently deleted.",
      confirmLabel: "Delete Data",
      destructive: true,
    });
    if (!ok) return;
    setPurgingProject(true);
    setDeployOk(null);
    setDeployLog("");
    const final = await startProjectAction(project.id, "stop-purge");
    setPurgingProject(false);
    if (!final) {
      setDeployOk(false);
    } else if (final.status === "running") {
      applyRepoActionSnapshot(final);
    } else {
      setDeployLog(final.log);
      setDeployOk(final.ok);
    }
  }

  async function deleteCurrentProject() {
    if (!project) return;
    const ok = await confirm({
      title: `Delete ${project.name}?`,
      description: "This removes the project configuration and detaches it from health checks.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    const projectName = project.name;
    const toastId = notify.loading(`Deleting ${projectName}...`);
    setDeletingProject(true);
    try {
      await api.deleteProject(project.id);
      notify.success(`${projectName} deleted.`, { id: toastId });
      navigate("/projects");
    } catch (err) {
      notify.error(err, `Failed to delete ${projectName}`, { id: toastId });
      setDeletingProject(false);
    }
  }

  async function saveProjectConfig(e?: React.FormEvent) {
    e?.preventDefault();
    if (!project) return;
    const toastId = notify.loading("Saving project runtime settings...");
    setSavingConfig(true);
    setConfigError("");
    try {
      const updated = await api.updateProject(project.id, {
        groupName: configGroupName.trim() || null,
        githubRepo: configRepo || null,
        githubCredentialId: configGithubCredentialId,
        healthCheckEndpoint: configHealthEndpoint || null,
        healthCheckDomainId: configHealthDomainId,
        healthCheckIntervalS: configIntervalS,
        autoDeployBranch: configAutoDeployBranch || null,
        nginxExtraConfig: configNginxExtra.trim() || null,
        nginxExtraBlocks: configNginxExtraBlocks.trim() || null,
      });
      const withComposeFile = configComposeFile && configComposeFile !== (project.composeFile ?? "")
        ? await api.setProjectComposeFile(updated.id, configComposeFile)
        : updated;
      setProject(withComposeFile);
      syncConfig(withComposeFile);
      await refreshProjects();
      notify.success("Project runtime settings saved.", { id: toastId });
    } catch (err) {
      setConfigError(err instanceof ApiError ? err.message : "Failed to save project settings");
      notify.error(err, "Failed to save project runtime settings", { id: toastId });
    } finally {
      setSavingConfig(false);
    }
  }

  async function handleCertAction(domain: string, action: "issue" | "renew" | "delete") {
    await certbotAction(domain, action);
  }

  async function addDomain() {
    const port = Number(newDomainPort);
    if (!project || !newDomainInput.trim() || !newDomainService.trim() || !Number.isInteger(port) || port <= 0) return;
    setAddingDomain(true);
    setDomainError("");
    try {
      const created = await api.addProjectDomain(project.id, newDomainInput.trim(), newDomainService.trim(), port);
      setDomains((current) => [...current, created]);
      if (project.healthCheckDomainId === null) {
        setProject((current) => current ? { ...current, healthCheckDomainId: created.id } : current);
        setConfigHealthDomainId((current) => current ?? created.id);
      }
      setNewDomainInput("");
      setNewDomainService("");
      setNewDomainPort("");
    } catch (err) {
      setDomainError(err instanceof ApiError ? err.message : "Failed to add domain");
    } finally {
      setAddingDomain(false);
    }
  }

  async function addTcpExposure() {
    const publicPort = Number(newTcpPublicPort);
    const containerPort = Number(newTcpContainerPort);
    if (!project || !Number.isInteger(publicPort) || !newTcpService || !Number.isInteger(containerPort)) return;
    setAddingTcpExposure(true);
    setTcpExposureError("");
    try {
      const created = await api.addTcpExposure(project.id, publicPort, newTcpService, containerPort);
      setTcpExposures((current) => [...current, created].sort((a, b) => a.publicPort - b.publicPort));
      setNewTcpPublicPort("");
      setNewTcpService("");
      setNewTcpContainerPort("");
      notify.success(`TCP port ${publicPort} is exposed.`);
    } catch (err) {
      setTcpExposureError(err instanceof ApiError ? err.message : "Failed to add TCP exposure");
    } finally {
      setAddingTcpExposure(false);
    }
  }

  async function removeTcpExposureRow(exposure: TcpExposure) {
    if (!project) return;
    const ok = await confirm({
      title: `Remove public TCP port ${exposure.publicPort}?`,
      description: `This removes only the StackPort TCP proxy to ${exposure.service}:${exposure.containerPort}.`,
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.removeTcpExposure(project.id, exposure.id);
      setTcpExposures((current) => current.filter((item) => item.id !== exposure.id));
      notify.success(`TCP port ${exposure.publicPort} removed.`);
    } catch (err) {
      notify.error(err, `Failed to remove TCP port ${exposure.publicPort}`);
    }
  }

  async function removeDomainRow(domain: ProjectDomain) {
    if (!project) return;
    const ok = await confirm({
      title: `Remove ${domain.domain}?`,
      description: "This stops routing the domain to this project. Any issued certificate stays on disk untouched.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.removeProjectDomain(project.id, domain.id);
      const remainingDomains = domains.filter((d) => d.id !== domain.id);
      const nextDomainId = project.healthCheckDomainId === domain.id ? remainingDomains[0]?.id ?? null : project.healthCheckDomainId;
      setDomains(remainingDomains);
      setProject((current) => current ? { ...current, healthCheckDomainId: nextDomainId } : current);
      if (configHealthDomainId === domain.id) setConfigHealthDomainId(nextDomainId);
    } catch (err) {
      notify.error(err, `Failed to remove ${domain.domain}`);
    }
  }

  async function toggleDomainSsl(domain: ProjectDomain, useSsl: boolean) {
    if (!project) return;
    try {
      const updated = await api.setProjectDomainSsl(project.id, domain.id, useSsl);
      setDomains((current) => current.map((d) => (d.id === domain.id ? updated : d)));
    } catch (err) {
      notify.error(err, `Failed to update SSL for ${domain.domain}`);
    }
  }

  async function issueDomainSsl(domain: ProjectDomain) {
    if (!project) return;
    const final = await issueProjectDomainSsl(project.id, domain.id);
    if (final?.ok) {
      setDomains((current) => current.map((d) => (d.id === domain.id ? { ...d, useSsl: true } : d)));
    }
  }

  const runtimeChanged = project ? (
    configGroupName.trim() !== (project.groupName ?? "") ||
    configRepo !== (project.githubRepo ?? "") ||
    configGithubCredentialId !== project.githubCredentialId ||
    configHealthEndpoint !== (project.healthCheckEndpoint ?? "") ||
    configHealthDomainId !== project.healthCheckDomainId ||
    configIntervalS !== project.healthCheckIntervalS ||
    configAutoDeployBranch !== (project.autoDeployBranch ?? "") ||
    configNginxExtra !== (project.nginxExtraConfig ?? "") ||
    configNginxExtraBlocks !== (project.nginxExtraBlocks ?? "") ||
    configComposeFile !== (project.composeFile ?? "")
  ) : false;
  const runtimeFormId = project ? `project-runtime-${project.id}` : "project-runtime";

  function certbotRecordFor(domain: string): ActionRecord | null {
    return certbotRecords
      .filter((entry) => entry.meta?.["domain"] === domain)
      .reduce<ActionRecord | null>((latest, entry) => (
        !latest || new Date(entry.startedAt) > new Date(latest.startedAt) ? entry : latest
      ), null);
  }

  useEffect(() => {
    runtimeChangedRef.current = runtimeChanged;
  }, [runtimeChanged]);

  useEffect(() => {
    void load();
  }, [projectId]);

  useEffect(() => {
    if (!project) return;
    void loadDeploys();
    void loadRevisions();
    // Branch list is cached server-side (refreshed by the GitHub poller), so this is
    // normally instant; it only reaches GitHub when nothing has been cached yet.
    if (project.githubRepo && project.branches.length === 0) void loadBranches(false);
  }, [project?.id]);


  useEffect(() => {
    if (!Number.isInteger(projectId) || projectId <= 0) return;
    const handler = (event: ProjectDeployEvent) => {
      if (event.projectId !== projectId) return;

      deployLog.append(event.message);
      if (event.done) {
        if (event.action === "pull") setPullingRepo(false);
        if (event.action === "compose") setComposingProject(false);
        if (event.action === "recreate") setRecreatingProject(false);
        if (event.action === "force-rebuild") setForceRebuilding(false);
        if (event.action === "deploy") setDeploying(false);
        if (event.action === "stop") setStoppingProject(false);
        if (event.action === "stop-purge") setPurgingProject(false);
        if (event.action === "redeploy-service") setRedeployingService(null);
        if (event.action === "drop-volumes") setDroppingVolumesService(null);
        setDeployOk(event.ok ?? null);
        setFinishedAction({ kind: event.action, ok: event.ok ?? null, at: new Date().toISOString() });
        refreshSystem();
        // This handler outlives renders, so fetch by id rather than through the project-bound loaders.
        api.getProjectDeploys(projectId).then(setDeploys).catch(() => {});
        api.getProjectDeploymentRevisions(projectId).then(setRevisions).catch(() => {});
      }
    };
    subscribeDeploy<ProjectDeployEvent>(projectId, handler);
    return () => unsubscribeDeploy<ProjectDeployEvent>(projectId, handler);
  }, [projectId, refreshSystem, subscribeDeploy, unsubscribeDeploy]);

  useEffect(() => {
    if (!Number.isInteger(projectId) || projectId <= 0) return;
    const handler = (snapshot: ProjectActionsSnapshot) => {
      if (snapshot.repo) applyRepoActionSnapshot(snapshot.repo);
    };
    subscribeDeploySync<ProjectActionsSnapshot>(handler);
    return () => unsubscribeDeploySync<ProjectActionsSnapshot>(handler);
  }, [projectId, subscribeDeploySync, unsubscribeDeploySync]);

  useEffect(() => {
    if (!Number.isInteger(projectId) || projectId <= 0) return;
    const handler = (event: ProjectUpdateEvent) => {
      if (event.projectId !== projectId) return;
      setProject(event.project);
      if (!runtimeChangedRef.current) syncConfig(event.project);
    };
    subscribeProject<ProjectUpdateEvent>(projectId, handler);
    return () => unsubscribeProject<ProjectUpdateEvent>(projectId, handler);
  }, [projectId, subscribeProject, unsubscribeProject]);


  const repoBusy = pullingRepo || deploying || composingProject || recreatingProject || forceRebuilding ||
    stoppingProject || purgingProject || uploadingFiles || redeployingService !== null || droppingVolumesService !== null;
  /** Branch a Pull/Redeploy will check out: the explicit pick, else the auto-deploy branch. */
  const selectedBranch = pullBranch || project?.autoDeployBranch || "";
  const certbotAvailable = certbotInfo.available;
  function certbotEntryFor(domain: string) {
    return certbotInfo.entries.find((e) => e.domain === domain) ?? null;
  }
  const expectedStackName = project ? expectedComposeProjectName(project) : "";
  const dockerStack = docker?.stack ?? null;
  const monitoredContainers = healthMonitoredContainers(dockerStack);
  const ignoredContainerCount = dockerStack?.containers.filter((container) => container.healthCheckIgnored).length ?? 0;
  const dockerRunningCount = monitoredContainers.filter((c) => c.state === "running").length;
  const dockerTotalCount = monitoredContainers.length;
  const dockerAllRunning = dockerTotalCount > 0 && dockerRunningCount === dockerTotalCount;
  const dockerAnyRunning = dockerRunningCount > 0;
  const dockerStackStatusClass = dockerTotalCount === 0 && ignoredContainerCount > 0
    ? styles.statusUnknown
    : dockerAllRunning ? styles.statusUp : dockerAnyRunning ? styles.statusUnknown : styles.statusDown;
  const dockerStackStatus = dockerStack
    ? dockerTotalCount === 0 && ignoredContainerCount > 0
      ? "Helpers only"
      : dockerAllRunning ? "Running" : dockerAnyRunning ? "Partial" : "Stopped"
    : "Not found";
  const dockerPorts = dockerStack?.containers.flatMap((c) => c.ports ? [c.ports] : []) ?? [];
  const displayStatus: ProjectStatusKind = project
    ? deriveProjectStatus(project, dockerStack, docker?.available ?? false)
    : "not-deployed";
  const displayStatusReason = project
    ? explainProjectStatus(project, dockerStack, docker?.available ?? false, displayStatus)
    : "";

  return (
    <>
      <main className="main">
        <div className={cn("page-title", styles.pageTitle)}>
          <span className={styles.titleName}>
            <FolderDot size={20} />
            {project?.name ?? "Project"}
          </span>
          <div className={styles.titleActions}>
            <Link className="btn btn-ghost btn-sm" to="/projects">
              <ArrowLeft size={13} />
              Projects
            </Link>
          </div>
        </div>

        {loading ? (
          <div className="empty" style={{ padding: 48 }}>
            <Loader size={22} className="spin" />
          </div>
        ) : error ? (
          <div className="alert alert-error">{error}</div>
        ) : project ? (
          <>
            {/* ── Status card ─────────────────────────────────────────── */}
            <div className="card">
              <div className={styles.statusRow}>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className={cn(styles.statusPill, statusPillClass(displayStatus, styles))}>
                        {projectStatusLabel(displayStatus)}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">{displayStatusReason}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                {domains.length > 0 ? (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <a
                      className={cn("mono", styles.domainLink)}
                      href={`${domains[0].useSsl ? "https" : "http"}://${domains[0].domain}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {domains[0].domain}
                    </a>
                    {domains.length > 1 && (
                      <span className="muted-text" style={{ fontSize: 12 }}>+{domains.length - 1} more</span>
                    )}
                  </span>
                ) : (
                  <span className="muted-text" style={{ fontSize: 13 }}>No domain</span>
                )}
                {project.lastCommitSha && (
                  <span className={styles.statusCommit} title={project.lastCommitMessage ?? undefined}>
                    <GitCommit size={12} />
                    <span className="mono">{project.lastCommitSha.slice(0, 7)}</span>
                    {project.lastCommitAt && <span className="muted-text"><TimeAgo ts={project.lastCommitAt} /></span>}
                  </span>
                )}
              </div>

              <div className={styles.toolbar}>
                {project.sourceType === "github" && (
                  <div className={styles.branchGroup} role="group" aria-label="Branch">
                    <GitBranch size={13} className={styles.branchGroupIcon} />
                    <AppSelect
                      value={pullBranch}
                      onValueChange={setPullBranch}
                      disabled={repoBusy || project.paused}
                      triggerClassName={styles.branchSelect}
                      placeholder="Select a branch"
                      options={[
                        ...(project.autoDeployBranch
                          ? [{ value: "", label: `${project.autoDeployBranch} (auto-deploy)` }]
                          : [{ value: "", label: "Select a branch", disabled: true }]),
                        ...branches
                          .filter((b) => b.name !== project.autoDeployBranch)
                          .map((b) => ({ value: b.name, label: b.name })),
                      ]}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => void loadBranches(true)}
                      disabled={loadingBranches || !project.githubRepo}
                      title="Refresh branch list from GitHub"
                      aria-label="Refresh branch list"
                    >
                      {loadingBranches ? <Loader size={13} className="spin" /> : <RefreshCw size={13} />}
                    </Button>
                    <span className={styles.toolbarDivider} />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void runProjectCommand("pull", pullBranch ? { branch: pullBranch } : undefined)}
                      disabled={repoBusy || !project.githubRepo || !selectedBranch || project.paused}
                      title={selectedBranch ? `Pull ${selectedBranch} from GitHub (no rebuild)` : "Pick a branch first"}
                    >
                      {pullingRepo ? <Loader size={13} className="spin" /> : <GitBranch size={13} />}
                      Pull
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => void runProjectCommand("deploy", pullBranch ? { branch: pullBranch } : undefined)}
                      disabled={repoBusy || !project.githubRepo || !selectedBranch || project.paused}
                      title={selectedBranch ? `Pull ${selectedBranch}, then docker compose up -d --build` : "Pick a branch first"}
                    >
                      {deploying ? <Loader size={13} className="spin" /> : <Rocket size={13} />}
                      Redeploy
                    </Button>
                  </div>
                )}
                {project.sourceType === "upload" && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setReuploadOpen((open) => !open)}
                    disabled={repoBusy || project.paused}
                  >
                    {uploadingFiles ? <Loader size={13} className="spin" /> : <Upload size={13} />}
                    Re-upload files
                  </Button>
                )}
                <div className={styles.toolbarActions}>
                  <Button type="button" variant="outline" size="sm" onClick={() => setEnvManagerOpen(true)}>
                    <KeyRound size={13} />
                    Env
                    <span className={styles.actionCount}>{envFiles.length}</span>
                  </Button>
                  <Button
                    type="button"
                    variant={project.sourceType === "github" ? "outline" : "default"}
                    size="sm"
                    onClick={() => void runProjectCommand("compose")}
                    disabled={repoBusy || (project.sourceType === "github" && !project.githubRepo) || project.paused}
                    title="docker compose up -d --build on the current checkout (no git pull)"
                  >
                    {composingProject ? <Loader size={13} className="spin" /> : <Box size={13} />}
                    Compose up
                  </Button>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button type="button" variant="outline" size="sm">
                        <EllipsisVertical size={13} />
                        Actions
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="end" className={styles.actionsMenu}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className={styles.actionsMenuItem}
                        onClick={() => void runProjectCommand("compose")}
                        disabled={composingProject || recreatingProject || forceRebuilding || deploying || pullingRepo || stoppingProject || (project.sourceType === "github" && !project.githubRepo) || project.paused}
                      >
                        {composingProject ? <Loader size={13} className="spin" /> : <Hammer size={13} />}
                        Rebuild
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className={styles.actionsMenuItem}
                        onClick={() => void runProjectCommand("recreate")}
                        disabled={recreatingProject || forceRebuilding || deploying || pullingRepo || composingProject || stoppingProject || (project.sourceType === "github" && !project.githubRepo) || project.paused}
                        title="docker compose up -d --build --force-recreate — forces containers to recreate even if Compose thinks nothing changed (e.g. after an env file edit)"
                      >
                        {recreatingProject ? <Loader size={13} className="spin" /> : <Zap size={13} />}
                        Force Recreate
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className={styles.actionsMenuItem}
                        onClick={() => void runProjectCommand("force-rebuild")}
                        disabled={forceRebuilding || recreatingProject || deploying || pullingRepo || composingProject || stoppingProject || (project.sourceType === "github" && !project.githubRepo) || project.paused}
                        title="docker compose build --no-cache, then up -d --force-recreate — ignores Docker's build cache entirely. Slower, but the real fix when a rebuild keeps reusing a stale cached layer (e.g. a baked-in env file)."
                      >
                        {forceRebuilding ? <Loader size={13} className="spin" /> : <FlameKindling size={13} />}
                        Force Rebuild
                      </Button>
                      {project.healthCheckIntervalS > 0 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className={styles.actionsMenuItem}
                          onClick={() => void triggerHealthCheck()}
                          disabled={checkingHealth || deploying || stoppingProject}
                          title={project.lastCheckedAt ? `Last checked ${formatTimeAgo(project.lastCheckedAt)}` : "Run health check now"}
                        >
                          {checkingHealth ? <Loader size={13} className="spin" /> : <Activity size={13} />}
                          Check
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className={styles.actionsMenuItem}
                        onClick={() => void toggleProjectPaused()}
                        disabled={togglingProject || deploying || pullingRepo || composingProject || recreatingProject || forceRebuilding || stoppingProject}
                      >
                        {togglingProject ? <Loader size={13} className="spin" /> : project.paused ? <Play size={13} /> : <Pause size={13} />}
                        {project.paused ? "Start" : "Pause"}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className={cn(styles.actionsMenuItem, styles.dangerAction)}
                        onClick={() => void stopCurrentProject()}
                        disabled={stoppingProject || purgingProject || deploying || pullingRepo || composingProject || recreatingProject || forceRebuilding || (project.sourceType === "github" && !project.githubRepo)}
                      >
                        {stoppingProject ? <Loader size={13} className="spin" /> : <Square size={13} />}
                        Stop
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className={cn(styles.actionsMenuItem, styles.dangerAction)}
                        onClick={() => void stopAndPurgeCurrentProject()}
                        disabled={purgingProject || stoppingProject || deploying || pullingRepo || composingProject || recreatingProject || forceRebuilding || (project.sourceType === "github" && !project.githubRepo)}
                        title="docker compose down -v — removes containers and all volumes"
                      >
                        {purgingProject ? <Loader size={13} className="spin" /> : <Trash2 size={13} />}
                        Stop & Delete Data
                      </Button>
                      <div className={styles.actionsMenuSeparator} role="separator" />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className={cn(styles.actionsMenuItem, styles.dangerAction)}
                        onClick={() => void deleteCurrentProject()}
                        disabled={deletingProject || repoBusy}
                        title={repoBusy ? "Wait for the running action to finish" : "Remove this project from Stackport"}
                      >
                        {deletingProject ? <Loader size={13} className="spin" /> : <Trash2 size={13} />}
                        Delete project
                      </Button>
                    </PopoverContent>
                  </Popover>
                </div>
              </div>

              {reuploadOpen && project.sourceType === "upload" && (
                <div className={styles.commitInfo} style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
                  <div className="field field-wide">
                    <label><FileText size={12} />docker-compose.yml</label>
                    <input
                      type="file"
                      accept=".yml,.yaml"
                      disabled={uploadingFiles}
                      onChange={(e) => setReuploadComposeFile(e.target.files?.[0] ?? null)}
                    />
                  </div>
                  <div className="field field-wide">
                    <label>Support files <span className="hint mono">(re-upload replaces the whole directory — include every file this project needs, not just the ones that changed)</span></label>
                    {reuploadSupportFiles.map((supportFile, index) => (
                      <div key={index} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                        <input
                          type="file"
                          disabled={uploadingFiles}
                          onChange={(e) => updateReuploadSupportFile(index, { file: e.target.files?.[0] ?? null })}
                        />
                        <input
                          type="text"
                          placeholder="relative path, e.g. nginx/nginx.conf"
                          value={supportFile.path}
                          disabled={uploadingFiles}
                          onChange={(e) => updateReuploadSupportFile(index, { path: e.target.value })}
                        />
                        <button type="button" className="btn-icon" onClick={() => removeReuploadSupportFile(index)} disabled={uploadingFiles} aria-label="Remove file">
                          <X size={14} />
                        </button>
                      </div>
                    ))}
                    <button type="button" className="btn btn-ghost btn-sm" onClick={addReuploadSupportFile} disabled={uploadingFiles}>
                      <Plus size={13} />
                      Add support file
                    </button>
                  </div>
                  <div className="wizard-actions">
                    <button type="button" className="btn btn-ghost" onClick={() => setReuploadOpen(false)} disabled={uploadingFiles}>Cancel</button>
                    <button type="button" className="btn btn-primary" onClick={() => void runReupload()} disabled={uploadingFiles || !reuploadComposeFile}>
                      {uploadingFiles ? <Loader size={14} className="spin" /> : <Upload size={14} />}
                      Upload &amp; deploy
                    </button>
                  </div>
                </div>
              )}

              <ActionResult
                store={deployLog}
                running={repoBusy}
                finished={finishedAction ?? (deployOk === null ? null : { kind: "", ok: deployOk, at: null })}
                latestRevision={revisions[0] ?? null}
              />
            </div>

            {/* ── Docker expandable card ───────────────────────────────── */}
            <ExpandableCard
              icon={<Box size={13} />}
              title="Docker"
              storageKey="project.docker"
              summary={
                !systemLoaded ? (
                  <Loader size={11} className="spin" />
                ) : !docker?.available ? (
                  <span style={{ color: "var(--danger)", fontSize: 12 }}>Unavailable</span>
                ) : (
                  <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span className={cn(styles.statusPill, dockerStackStatusClass)} style={{ fontSize: 11 }}>
                      {dockerStackStatus}
                    </span>
                    {dockerStack && (
                      <span className="mono" style={{ fontSize: 12, color: "var(--dim)" }}>
                        {dockerRunningCount}/{dockerTotalCount}
                        {ignoredContainerCount > 0 && ` +${ignoredContainerCount} helper${ignoredContainerCount === 1 ? "" : "s"}`}
                      </span>
                    )}
                    {dockerPorts.length > 0 && (
                      <span className="mono path-text" style={{ fontSize: 11, color: "var(--dim)" }}>
                        {dockerPorts.join(", ")}
                      </span>
                    )}
                  </span>
                )
              }
            >
              {!docker?.available ? (
                <ServiceError service="Docker" reason={docker?.reason} />
              ) : dockerStack ? (
                <>
                  <div className={styles.dockerContainerList} style={{ marginTop: 0 }}>
                    <div className={styles.dockerContainerHeader}>
                      <span>Service</span>
                      <span>State</span>
                      <span>Status</span>
                      <span>Ports</span>
                      <span>Actions</span>
                    </div>
                    {dockerStack.containers.length === 0 ? (
                      <div className={styles.dockerContainerEmpty}>No containers found for this stack.</div>
                    ) : dockerStack.containers.map((container) => (
                      <DockerContainerRow
                        key={container.id}
                        container={container}
                        onOpenShell={setShellContainer}
                        onOpenLogs={setLogStreamContainer}
                        onRedeploy={dockerStack.containers.length > 1 ? (c) => void redeployService(c.service ?? c.name) : undefined}
                        redeploying={redeployingService === (container.service ?? container.name)}
                        redeployDisabled={
                          redeployingService !== null || droppingVolumesService !== null || pullingRepo || deploying ||
                          composingProject || recreatingProject || forceRebuilding || stoppingProject || purgingProject
                        }
                        onDropVolumes={dockerStack.containers.length > 1 ? (c) => void dropServiceVolumes(c.service ?? c.name) : undefined}
                        droppingVolumes={droppingVolumesService === (container.service ?? container.name)}
                        dropVolumesDisabled={
                          droppingVolumesService !== null || redeployingService !== null || pullingRepo || deploying ||
                          composingProject || recreatingProject || forceRebuilding || stoppingProject || purgingProject
                        }
                      />
                    ))}
                  </div>
                  <div className={styles.logsSection}>
                    <div className={styles.logsToolbar}>
                      <AppSelect
                        value={logsService}
                        onValueChange={setLogsService}
                        options={[
                          { value: "", label: "All services" },
                          ...dockerStack.containers
                            .map((c) => c.service ?? c.name)
                            .filter((s, i, arr) => arr.indexOf(s) === i)
                            .map((s) => ({ value: s, label: s })),
                        ]}
                      />
                      <AppSelect
                        value={String(logsTail)}
                        onValueChange={(v) => setLogsTail(Number(v))}
                        options={[
                          { value: "50", label: "50 lines" },
                          { value: "100", label: "100 lines" },
                          { value: "200", label: "200 lines" },
                          { value: "500", label: "500 lines" },
                        ]}
                      />
                      <Button type="button" variant="outline" size="sm" onClick={() => void fetchDockerLogs()} disabled={logsLoading}>
                        {logsLoading ? <Loader size={13} className="spin" /> : <ScrollText size={13} />}
                        Logs
                      </Button>
                      {logsOutput !== null && (
                        <Button type="button" variant="ghost" size="sm" onClick={() => setLogsOutput(null)}>
                          <X size={13} />
                          Clear
                        </Button>
                      )}
                    </div>
                    {logsOutput !== null && (
                      <pre className="output-block" style={{ maxHeight: 480, overflowY: "auto" }}>
                        {parseAnsi(logsOutput)}
                      </pre>
                    )}
                  </div>
                </>
              ) : (
                <div className={styles.dockerContainerEmpty}>
                  No stack found for <span className="mono">{expectedStackName}</span>
                </div>
              )}
            </ExpandableCard>

            {/* ── Domains & ports card (changes apply immediately, not through Save) ── */}
            <ExpandableCard
              icon={<Globe size={13} />}
              title="Domains & ports"
              storageKey="project.ingress"
              defaultOpen
              summary={<span className={styles.cardSummaryText}>{domains.length} domain{domains.length === 1 ? "" : "s"}{tcpExposures.length > 0 ? ` · ${tcpExposures.length} TCP` : ""}</span>}
            >
              <div className={styles.ingressBlock}>
                <div className={styles.historyHeading}>Domains</div>
                <p className="muted-text">Each domain routes to a compose service and container port over the stackport-proxy network.</p>
                <div className="row-actions">
                  <Input
                    type="text"
                    placeholder="myapp.example.com"
                    value={newDomainInput}
                    onChange={(e) => setNewDomainInput(e.target.value)}
                    className={styles.domainInput}
                  />
                  <ProjectIngressSelect projectId={project.id} composeFile={project.composeFile}
                    refreshKey={project.updatedAt} disabled={addingDomain}
                    value={newDomainService && newDomainPort ? `${newDomainService}:${newDomainPort}` : ""}
                    onValueChange={value => { const [service = "", port = ""] = value.split(":"); setNewDomainService(service); setNewDomainPort(port); }} />
                  <Button
                    type="button"
                    variant="outline"
                    size="default"
                    onClick={() => void addDomain()}
                    disabled={addingDomain || !newDomainInput.trim() || !newDomainService.trim() || !newDomainPort.trim()}
                    title={!newDomainInput.trim() ? "Type a domain first" : !newDomainService.trim() ? "Pick the service and port it should reach" : undefined}
                  >
                    {addingDomain ? <Loader size={12} className="spin" /> : <Plus size={12} />}
                    Add domain
                  </Button>
                </div>
                {domainError && <div className={styles.inlineError}>{domainError}</div>}
                {domains.length === 0 ? (
                  <div className="muted-text">No domains routed to this project.</div>
                ) : (
                  <div className={styles.ingressList}>
                    {domains.map((domain) => (
                      <DomainRow
                        key={domain.id}
                        domain={domain}
                        cert={certbotEntryFor(domain.domain)}
                        certRecord={certbotRecordFor(domain.domain)}
                        certbotAvailable={certbotAvailable}
                        onToggleSsl={(checked) => void toggleDomainSsl(domain, checked)}
                        onIssue={() => void issueDomainSsl(domain)}
                        onCertAction={(action) => void handleCertAction(domain.domain, action)}
                        onRemove={() => void removeDomainRow(domain)}
                      />
                    ))}
                  </div>
                )}
              </div>

              <div className={styles.ingressBlock}>
                <div className={styles.historyHeading}>TCP ports</div>
                <div className={styles.tcpWarningCard} role="note" aria-label="Public TCP security warning">
                  <AlertTriangle size={17} />
                  <div>
                    <strong>Public TCP security boundary</strong>
                    <span>Public TCP ports are reachable outside the VPS. Authentication, TLS, and protocol security remain the application's responsibility.</span>
                  </div>
                </div>
                <div className="row-actions">
                  <NumberInput
                    min={1}
                    max={65535}
                    placeholder="Public port"
                    aria-label="Public port"
                    value={newTcpPublicPort === "" ? null : Number(newTcpPublicPort)}
                    onValueChange={(port) => setNewTcpPublicPort(port == null ? "" : String(port))}
                    className={styles.portInput}
                  />
                  <ProjectIngressSelect projectId={project.id} composeFile={project.composeFile}
                    refreshKey={project.updatedAt} disabled={addingTcpExposure}
                    value={newTcpService && newTcpContainerPort ? `${newTcpService}:${newTcpContainerPort}` : ""}
                    onValueChange={value => { const [service = "", port = ""] = value.split(":"); setNewTcpService(service); setNewTcpContainerPort(port); }} />
                  <Button type="button" variant="outline" size="default" onClick={() => void addTcpExposure()}
                    disabled={addingTcpExposure || !newTcpPublicPort || !newTcpService || !newTcpContainerPort}
                    title={!newTcpPublicPort ? "Type a public port first" : !newTcpService ? "Pick the service and port it should reach" : undefined}>
                    {addingTcpExposure ? <Loader size={12} className="spin" /> : <Plus size={12} />}
                    Expose
                  </Button>
                </div>
                {tcpExposureError && <div className={styles.inlineError}>{tcpExposureError}</div>}
                {tcpExposures.length === 0 ? (
                  <div className="muted-text">No public TCP ports configured.</div>
                ) : (
                  <div className={styles.ingressList}>
                    {tcpExposures.map((exposure) => (
                      <TcpExposureRow key={exposure.id} exposure={exposure} onRemove={() => void removeTcpExposureRow(exposure)} />
                    ))}
                  </div>
                )}
              </div>
            </ExpandableCard>

            {/* ── Project config card ──────────────────────────────────── */}
            <ExpandableCard
              icon={<FileText size={13} />}
              title="Project Config"
              storageKey="project.config"
              className={styles.runtimeCard}
              summary={runtimeChanged ? <span className={styles.unsavedHint}>Unsaved changes</span> : undefined}
              actions={(
                <Button
                  type="button"
                  size="xs"
                  onClick={() => void saveProjectConfig()}
                  disabled={savingConfig || !runtimeChanged}
                >
                  {savingConfig ? <Loader size={12} className="spin" /> : <Save size={12} />}
                  Save
                </Button>
              )}
            >
              {configError && <div className="alert alert-error">{configError}</div>}

              <form id={runtimeFormId} className={styles.runtimeForm} onSubmit={(e) => void saveProjectConfig(e)}>
                <ProjectGroupField value={configGroupName} onValueChange={setConfigGroupName} projects={allProjects ?? []} disabled={savingConfig} />
                <ConfigSection title="Repository" storageKey="repository">
                  <div className="field field-wide">
                    <label>GitHub repo <span className="hint mono">(owner/repo)</span></label>
                    <input type="text" value={configRepo} onChange={(e) => setConfigRepo(e.target.value)} />
                  </div>
                  <div className="field">
                    <label>GitHub token</label>
                    <GitHubTokenSelect
                      credentials={credentials}
                      value={configGithubCredentialId}
                      onValueChange={setConfigGithubCredentialId}
                    />
                  </div>
                  <div className="field">
                    <label>
                      <GitBranch size={12} />
                      Auto-deploy branch
                      <span className="hint"> (new commits here deploy automatically)</span>
                    </label>
                    <ActionSelect
                      value={configAutoDeployBranch}
                      onValueChange={setConfigAutoDeployBranch}
                      options={[
                        { value: "", label: "Off — no auto-deploy" },
                        ...branches.map((b) => ({
                          value: b.name,
                          label: b.name,
                        })),
                        ...(configAutoDeployBranch && !branches.some((b) => b.name === configAutoDeployBranch)
                          ? [{ value: configAutoDeployBranch, label: `Current: ${configAutoDeployBranch}` }]
                          : []),
                      ]}
                      action={(
                        <Button
                          type="button"
                          variant="outline"
                          size="icon-sm"
                          onClick={() => void loadBranches()}
                          disabled={loadingBranches || !configRepo}
                          title="Fetch branches from GitHub"
                        >
                          {loadingBranches ? <Loader size={13} className="spin" /> : <RefreshCw size={13} />}
                        </Button>
                      )}
                    />
                    {branchError && <div style={{ fontSize: "0.78rem", color: "var(--danger)", marginTop: 4 }}>{branchError}</div>}
                  </div>
                </ConfigSection>


                <ConfigSection title="Compose & Nginx" storageKey="compose-nginx" defaultOpen={false}>
                  {(project.availableComposeFiles.length > 0 || project.composeFile) && (
                    <div className="field">
                      <label>Compose file</label>
                      <ActionSelect
                        value={configComposeFile}
                        onValueChange={setConfigComposeFile}
                        options={[
                          ...project.availableComposeFiles.map((file) => ({ value: file, label: file })),
                          ...(project.composeFile && !project.availableComposeFiles.includes(project.composeFile)
                            ? [{ value: project.composeFile, label: project.composeFile }]
                            : []),
                        ]}
                        action={(
                          <Button
                            type="button"
                            variant="outline"
                            size="icon-sm"
                            onClick={() => setComposeFileDialogOpen(true)}
                            disabled={!project.composeFile}
                            title="View docker-compose.yml"
                          >
                            <FileText size={13} />
                          </Button>
                        )}
                      />
                    </div>
                  )}
                  <div className="field field-wide" style={{ gridColumn: "1 / -1" }}>
                    <label>
                      Extra Nginx config
                      <span className="hint"> (raw directives appended inside the proxy location block, e.g. client_max_body_size)</span>
                    </label>
                    <textarea
                      className="mono"
                      rows={4}
                      placeholder={"client_max_body_size 520M;\nclient_body_timeout 300s;\nproxy_read_timeout 300s;\nproxy_send_timeout 300s;"}
                      value={configNginxExtra}
                      onChange={(e) => setConfigNginxExtra(e.target.value)}
                    />
                  </div>
                  <div className="field field-wide" style={{ gridColumn: "1 / -1" }}>
                    <label>
                      Extra Nginx blocks <span className="hint">(HTTPS server only — raw blocks appended after the proxy location, e.g. an extra `location`. Use {"{{PORT}}"} for this project's internal port)</span>
                    </label>
                    <textarea
                      className="mono"
                      rows={6}
                      placeholder={'location /specific/url {\n    proxy_pass http://127.0.0.1:{{PORT}};\n    proxy_http_version 1.1;\n    proxy_set_header X-specific-route-only "das";\n\n    proxy_set_header Host $host;\n    proxy_set_header X-Real-IP $remote_addr;\n    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n    proxy_set_header X-Forwarded-Proto $scheme;\n}'}
                      value={configNginxExtraBlocks}
                      onChange={(e) => setConfigNginxExtraBlocks(e.target.value)}
                    />
                  </div>
                </ConfigSection>


                <ConfigSection title="Health check" storageKey="health-check">
                  <div className="field">
                    <label>Domain <span className="hint">(HTTPS target)</span></label>
                    <AppSelect
                      value={configHealthDomainId === null ? "" : String(configHealthDomainId)}
                      onValueChange={(value) => setConfigHealthDomainId(value ? Number(value) : null)}
                      disabled={domains.length === 0}
                      placeholder="Select a domain"
                      options={domains.length > 0
                        ? domains.map((domain) => ({
                            value: String(domain.id),
                            label: domain.useSsl ? domain.domain : `${domain.domain} (SSL off)`,
                          }))
                        : [{ value: "", label: "No domains available", disabled: true }]}
                    />
                  </div>
                  <div className="field">
                    <label>Path</label>
                    <input type="text" placeholder="/health" value={configHealthEndpoint} onChange={(e) => setConfigHealthEndpoint(e.target.value)} />
                  </div>
                  <div className="field" style={{ minWidth: 120, flex: "none" }}>
                    <label>Interval</label>
                    <AppSelect
                      value={String(configIntervalS)}
                      onValueChange={(value) => setConfigIntervalS(Number(value))}
                      options={INTERVALS.map((interval) => ({
                        value: String(interval.value),
                        label: interval.label,
                      }))}
                    />
                  </div>
                </ConfigSection>
              </form>
            </ExpandableCard>

            {project.githubRepo && (
              <ExpandableCard
                icon={<GitBranch size={13} />}
                title="GitHub"
                storageKey="project.github"
                defaultOpen
                summary={(
                  <span className="mono" style={{ fontSize: 12 }}>
                    {project.githubRepo}
                    {project.autoDeployBranch && ` · ${project.autoDeployBranch}`}
                    {project.lastCommitSha && ` @ ${project.lastCommitSha.slice(0, 7)}`}
                  </span>
                )}
                actions={(
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => void loadBranches(true)}
                    disabled={loadingBranches}
                    title={project.branchesFetchedAt ? `Branch list updated $<TimeAgo ts={project.branchesFetchedAt} />` : "Fetch branches from GitHub"}
                  >
                    {loadingBranches ? <Loader size={12} className="spin" /> : <RefreshCw size={12} />}
                    Refresh branches
                  </Button>
                )}
              >

                <div className={styles.detailGrid}>
                  <DetailRow label="Repository" value={<a className="ext-link mono" href={`https://github.com/${project.githubRepo}`} target="_blank" rel="noopener noreferrer">{project.githubRepo} <ExternalLink size={10} /></a>} />
                  <DetailRow label="Auto-deploy branch" value={project.autoDeployBranch ? <span className="mono">{project.autoDeployBranch}</span> : <span className="muted-text">Off</span>} />
                  <div className={styles.detailRowWide}>
                    <DetailRow label="Deploy trigger" value={<DeployTriggerControl project={project} onChange={setProject} />} />
                  </div>
                  {project.lastCommitSha && (
                    <>
                      <DetailRow label="Last commit" value={<span className="mono" style={{ fontSize: "0.82em" }}>{project.lastCommitSha.slice(0, 7)}</span>} />
                      {project.lastCommitMessage && <DetailRow label="Message" value={<span style={{ fontSize: "0.88em" }}>{project.lastCommitMessage}</span>} />}
                      {project.lastCommitAuthor && <DetailRow label="Author" value={<span className="mono">{project.lastCommitAuthor}</span>} />}
                      {project.lastCommitAt && <DetailRow label="Committed" value={<span className="mono">{formatShortDateTime(project.lastCommitAt, "—")}</span>} />}
                    </>
                  )}
                </div>

                {branches.length > 0 && (
                  <div className={styles.historyBlock}>
                    <div className={styles.historyHeading}>
                      Branches ({branches.length})
                      {project.branchesFetchedAt && <span> · updated <TimeAgo ts={project.branchesFetchedAt} /></span>}
                    </div>
                    <ul className={styles.historyList}>
                      {branches.map((b) => (
                        <li key={b.name}>
                          <span className={cn("mono", styles.branchName, b.name === project.autoDeployBranch && styles.branchAuto)}>
                            <GitCommit size={11} />
                            {b.name}
                          </span>
                          {b.name === project.autoDeployBranch && <span className={styles.branchAutoTag}>auto-deploy</span>}
                          <span className={styles.historyMessage} title={b.commitMessage ?? undefined}>{b.commitMessage ?? ""}</span>
                          {b.commitAuthor && <span className={styles.historyMeta}>{b.commitAuthor}</span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

              </ExpandableCard>
            )}

            <DeploymentsCard
              deploys={deploys}
              revisions={revisions}
              loading={loadingDeploys}
              rollingBack={rollingBack}
              onRollback={() => void handleRollback()}
            />

            <ResourceUsageCard projectId={project.id} />

            <ExpandableCard
              icon={<FolderDot size={13} />}
              title="Project Metadata"
              storageKey="project.metadata"
              summary={<span className="mono" style={{ fontSize: 12 }}>#{project.id}</span>}
            >
              <div className={styles.detailGrid}>
                <DetailRow label="Project ID" value={<span className="mono">{project.id}</span>} />
                <DetailRow label="Created" value={<span className="mono">{formatShortDateTime(project.createdAt)}</span>} />
                <DetailRow label="Updated" value={<span className="mono">{formatShortDateTime(project.updatedAt)}</span>} />
              </div>
            </ExpandableCard>
          </>
        ) : null}

      </main>
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
      {composeFileDialogOpen && project && (
        <ComposeFileDialog projectId={project.id} projectName={project.name} onClose={() => setComposeFileDialogOpen(false)} />
      )}
      {envManagerOpen && project && (
        <EnvManagerDialog
          projectId={project.id}
          projectName={project.name}
          envFiles={envFiles}
          onEnvFilesChange={setEnvFiles}
          onClose={() => setEnvManagerOpen(false)}
        />
      )}
    </>
  );
}
