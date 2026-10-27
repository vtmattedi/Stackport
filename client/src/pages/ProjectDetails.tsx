import { PolicyViolations } from "./project/PolicyViolations";
import { RevisionPreview, useDeployWithPreview } from "../components/RevisionPreview";
import { lazy, memo, Suspense, useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs";
import {
  ArrowLeft, Box, EllipsisVertical, ExternalLink, FileText, FolderDot, GitBranch,
  Hammer, Loader, Pause, Play, Plus, RefreshCw, ScrollText, Square, Trash2, Upload, X, GitCommit, Activity, Zap, FlameKindling,
  SquareTerminal, Radio, KeyRound, Rocket,
} from "lucide-react";
import { AppSelect } from "../components/AppSelect";
import { DeployTriggerControl } from "../components/DeployTriggerControl";
import { ServiceError } from "../components/ServiceError";
import { ExpandableCard } from "../components/ExpandableCard";
import { ProjectResourceCharts as ProjectResourceChartsBase } from "../components/ProjectResourceCharts";
// The terminal dialogs pull in xterm (~90 KB gzipped); load it only when one opens.
const ContainerShellDialog = lazy(() => import("../components/ContainerShellDialog").then((m) => ({ default: m.ContainerShellDialog })));
const ContainerLogDialog = lazy(() => import("../components/ContainerLogDialog").then((m) => ({ default: m.ContainerLogDialog })));
import { EnvManagerDialog } from "../components/EnvManagerDialog";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/ui/tooltip";
import { useConfirm } from "../components/ConfirmDialog";
import { Button } from "../components/ui/button";
import { api, ApiError } from "../api/client";
import type {
  ContainerInfo,
  ProjectResourceData,
  ProjectResourceSampleEvent,
  GitHubBranch,
  ProjectDeploymentRevision,
} from "../api/types";
import { useSocket } from "../context/SocketContext";
import { jsonEqual, useSystemActions, useSystemSelector } from "../context/SystemContext";
import { waitForActionResult } from "../context/ActionTracker";
import { formatShortDateTime, formatTimeAgo } from "../lib/format";
import { parseAnsi } from "../lib/ansi";
import { deriveProjectStatus, expectedComposeProjectName, explainProjectStatus, findProjectStack, healthMonitoredContainers, projectStatusLabel, type ProjectStatusKind } from "../lib/projectStatus";
import { cn } from "../lib/utils";
import { notify } from "../lib/notify";
import styles from "./ProjectDetails.module.scss";
import { TimeAgo } from "../components/TimeAgo";
import { ActionResult, type FinishedAction } from "./project/ActionLog";
import {
  useCredentials,
  useProjectDeploys,
  useProjectDomains,
  useProjectEnvFiles,
  useProjectQuery,
  useProjectRepoAction,
  useProjectRevisions,
} from "./project/useProjectData";
import { DeploymentsCard } from "./project/DeploymentsCard";
import { SettingsTab } from "./project/SettingsTab";
import { DomainsTab } from "./project/DomainsTab";
import { DetailRow } from "./project/shared";




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


/** The project page's sections, each at /projects/:id/:tab. */
const PROJECT_TABS = [
  { id: "overview", label: "Overview" },
  { id: "deploys", label: "Deploys" },
  { id: "domains", label: "Domains" },
  { id: "settings", label: "Settings" },
] as const;
type ProjectTab = (typeof PROJECT_TABS)[number]["id"];

export default function ProjectDetails() {
  const { id, tab: tabParam } = useParams();
  const tab = PROJECT_TABS.some((t) => t.id === tabParam) ? (tabParam as ProjectTab) : "overview";
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { refreshSystem, startProjectAction, redeployProjectContainer, dropProjectServiceVolumes } = useSystemActions();
  const deployWithPreview = useDeployWithPreview();
  const projectId = Number(id);
  const projectValid = Number.isInteger(projectId) && projectId > 0;
  // Server data lives in the query cache (useProjectData.ts); socket events and the
  // action tracker keep it current, so this page holds only UI state.
  const { project, isLoading: loading, error: projectError, setProject } = useProjectQuery(projectId);
  const error = projectError ? (projectError instanceof ApiError ? projectError.message : projectError.message || "Failed to load project") : "";
  const [domains, setDomains] = useProjectDomains(projectId, projectValid);
  const repoAction = useProjectRepoAction(projectId, projectValid);
  const repoKind = repoAction.running?.kind ?? null;
  const runningService = typeof repoAction.running?.meta?.["service"] === "string" ? repoAction.running.meta["service"] as string : null;

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
  const [credentials] = useCredentials();
  const [envFiles, setEnvFiles] = useProjectEnvFiles(projectId, projectValid);
  const [envManagerOpen, setEnvManagerOpen] = useState(false);
  // What the build/deploy slot is doing comes from the running action itself, so it is
  // right after a reload or when the action was started elsewhere.
  const deploying = repoKind === "deploy";
  const pullingRepo = repoKind === "pull";
  const [pullBranch, setPullBranch] = useState("");
  const composingProject = repoKind === "compose";
  const recreatingProject = repoKind === "recreate";
  const forceRebuilding = repoKind === "force-rebuild";
  const redeployingService = repoKind === "redeploy-service" ? runningService : null;
  const droppingVolumesService = repoKind === "drop-volumes" ? runningService : null;
  const [togglingProject, setTogglingProject] = useState(false);
  const stoppingProject = repoKind === "stop";
  const purgingProject = repoKind === "stop-purge";
  const [uploadingLocal, setUploadingFiles] = useState(false);
  const uploadingFiles = uploadingLocal || repoKind === "upload";
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
  const last = repoAction.last;
  const finishedAction: FinishedAction | null = last ? { kind: last.kind, ok: last.ok, at: last.completedAt } : null;
  const [branches, setBranches] = useState<GitHubBranch[]>([]);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [branchError, setBranchError] = useState("");
  const [deploys, , loadingDeploys] = useProjectDeploys(projectId, projectValid);
  const [revisions] = useProjectRevisions(projectId, projectValid);
  const [rollingBack, setRollingBack] = useState(false);


  async function loadBranches(refresh = true) {
    if (!project?.githubRepo) return;
    setLoadingBranches(true);
    setBranchError("");
    try {
      const data = await api.getProjectBranches(project.id, refresh);
      setBranches(data.branches);
    } catch (err) {
      setBranchError(err instanceof ApiError ? err.message : "Failed to load branches");
    } finally {
      setLoadingBranches(false);
    }
  }

  async function handleRollback(target?: ProjectDeploymentRevision) {
    if (!project) return;
    const ok = await confirm({
      title: target?.commitSha ? `Restore revision ${target.commitSha.slice(0, 7)}?` : "Roll back to the previous deployment?",
      description: target
        ? "Checks out this revision's exact commit and compose file, then redeploys from it. The current deployment stays recorded in history."
        : "Checks out the newest earlier revision you haven't already rolled back from, with its exact commit and compose file, then redeploys from it. The current deployment stays recorded in history.",
      confirmLabel: "Roll back",
      destructive: true,
      body: (
        <RevisionPreview
          direction="rollback"
          queryKey={["project", project.id, "rollback-preview", target?.id ?? "default"]}
          load={() => api.getRollbackPreview(project.id, target?.id)}
        />
      ),
    });
    if (!ok) return;
    setRollingBack(true);
    try {
      // The action toast reports the outcome; revisions refetch when it ends.
      await startProjectAction(project.id, "rollback", target ? { deploymentId: target.id } : undefined);
      refreshSystem();
    } finally {
      setRollingBack(false);
    }
  }

  async function runProjectCommand(action: "pull" | "compose" | "deploy" | "recreate" | "force-rebuild", opts?: { branch?: string }) {
    if (!project) return;
    await startProjectAction(project.id, action, opts);
  }

  async function handleDeploy(branch: string | undefined) {
    if (project) await deployWithPreview(project, branch);
  }

  async function redeployService(service: string) {
    if (!project) return;
    await redeployProjectContainer(project.id, service);
  }

  async function dropServiceVolumes(service: string) {
    if (!project) return;
    const ok = await confirm({
      title: `Drop volumes for ${service}?`,
      description: `This stops ${service} and permanently deletes every volume mounted into it — any data it persisted (e.g. a database's contents) is gone. This cannot be undone.`,
      confirmLabel: "Drop Volumes",
      destructive: true,
      requireText: service,
    });
    if (!ok) return;
    await dropProjectServiceVolumes(project.id, service);
  }

  async function runReupload() {
    if (!project || !reuploadComposeFile) return;
    setUploadingFiles(true);
    try {
      const supportFiles = reuploadSupportFiles
        .filter((f): f is { file: File; path: string } => f.file !== null && f.path.trim().length > 0)
        .map((f) => ({ file: f.file, path: f.path.trim() }));
      const started = await api.uploadProjectCompose(project.id, reuploadComposeFile, supportFiles);
      if (!started.started) {
        notify.error(new Error(started.error ?? "An action is already running"), "Failed to start upload");
        return;
      }
      // The action toast reports the outcome; the dialog closes once it succeeded.
      const final = started.action ? await waitForActionResult(started.action.id) : null;
      if (final?.ok) {
        setReuploadOpen(false);
        setReuploadComposeFile(null);
        setReuploadSupportFiles([]);
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
    await startProjectAction(project.id, "stop");
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
      requireText: project.name,
    });
    if (!ok) return;
    await startProjectAction(project.id, "stop-purge");
  }

  async function deleteCurrentProject() {
    if (!project) return;
    const ok = await confirm({
      title: `Delete ${project.name}?`,
      description: "This removes the project from Stackport: its settings, env files, domains (they stop routing), TCP ports, webhook, deploy history and logs. Its containers keep running and its checkout stays on disk (Settings → Maintenance finds leftover folders); stop the project first if you want them gone.",
      confirmLabel: "Delete",
      destructive: true,
      requireText: project.name,
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




  // The project carries the branch list the poller cached; use it when there is one.
  useEffect(() => {
    if (project && project.branches.length > 0) setBranches(project.branches);
  }, [project?.branches]);

  useEffect(() => {
    if (!project) return;
    // Branch list is cached server-side (refreshed by the GitHub poller), so this is
    // normally instant; it only reaches GitHub when nothing has been cached yet.
    if (project.githubRepo && project.branches.length === 0) void loadBranches(false);
  }, [project?.id]);



  const repoBusy = pullingRepo || deploying || composingProject || recreatingProject || forceRebuilding ||
    stoppingProject || purgingProject || uploadingFiles || redeployingService !== null || droppingVolumesService !== null;
  /** Branch a Pull/Redeploy will check out: the explicit pick, else the auto-deploy branch. */
  const selectedBranch = pullBranch || project?.autoDeployBranch || "";
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

  if (tabParam !== undefined && tabParam !== tab) return <Navigate to={`/projects/${projectId}/overview`} replace />;

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
                      onClick={() => void handleDeploy(pullBranch || undefined)}
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
                actionId={repoAction.running?.id ?? last?.id ?? null}
                running={repoBusy}
                finished={finishedAction}
                latestRevision={revisions[0] ?? null}
              />
              <PolicyViolations projectId={project.id} />
            </div>

            <Tabs value={tab} onValueChange={(next) => navigate(`/projects/${project.id}/${next}`)} className={styles.projectTabs}>
              <TabsList variant="line" aria-label="Project sections">
                {PROJECT_TABS.map(({ id: value, label }) => (
                  <TabsTrigger key={value} value={value}>{label}</TabsTrigger>
                ))}
              </TabsList>
            </Tabs>

            {tab === "overview" && (
              <>
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

              <ResourceUsageCard projectId={project.id} />
              </>
            )}

            {tab === "deploys" && (
              <>
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
                onRollback={(target) => void handleRollback(target)}
              />

              </>
            )}

            {tab === "domains" && (
              <DomainsTab project={project} setProject={setProject} domains={domains} setDomains={setDomains} />
            )}

            <SettingsTab
              project={project}
              setProject={setProject}
              domains={domains}
              credentials={credentials}
              branches={branches}
              loadingBranches={loadingBranches}
              branchError={branchError}
              loadBranches={loadBranches}
              hidden={tab !== "settings"}
            />
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
