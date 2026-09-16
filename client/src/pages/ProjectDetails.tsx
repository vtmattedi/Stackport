import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft, Box, EllipsisVertical, ExternalLink, FileText, FolderDot, GitBranch,
  Hammer, Loader, Lock, Pause, Play, Plus, RefreshCw, Save, ScrollText, Square, Trash2, Upload, X, GitCommit, Activity, Zap, FlameKindling,
  SquareTerminal, Radio, RotateCw,
} from "lucide-react";
import { ActionSelect, AppSelect } from "../components/AppSelect";
import { ProjectGroupField } from "../components/ProjectGroupField";
import { ProjectIngressSelect } from "../components/ProjectIngressSelect";
import { GitHubTokenSelect } from "../components/GitHubTokenSelect";
import { ExpandableCard } from "../components/ExpandableCard";
import { ProjectResourceCharts } from "../components/ProjectResourceCharts";
import { ContainerShellDialog } from "../components/ContainerShellDialog";
import { ContainerLogDialog } from "../components/ContainerLogDialog";
import { ComposeFileDialog } from "../components/ComposeFileDialog";
import { Switch } from "../components/ui/switch";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/ui/tooltip";
import { useConfirm } from "../components/ConfirmDialog";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { api, ApiError } from "../api/client";
import type {
  ActionRecord,
  ContainerInfo,
  Credential,
  EnvVariable,
  Project,
  ProjectActionsSnapshot,
  ProjectDeployEvent,
  ProjectDomain,
  ProjectEnvFile,
  ProjectResourceData,
  ProjectResourceSampleEvent,
  ProjectUpdateEvent,
  GitHubBranch,
  ProjectDeploy,
  ProjectDeploymentRevision,
} from "../api/types";
import { useSocket } from "../context/SocketContext";
import { pollProjectAction, useSystem } from "../context/SystemContext";
import { formatShortDateTime, formatTimeAgo } from "../lib/format";
import { parseAnsi } from "../lib/ansi";
import { deriveProjectStatus, expectedComposeProjectName, explainProjectStatus, findProjectStack, projectStatusLabel, type ProjectStatusKind } from "../lib/projectStatus";
import { cn } from "../lib/utils";
import { notify } from "../lib/notify";
import { EMPTY_VARIABLE, normalizeEnvRelativePath, parseEnvText } from "../lib/env";
import styles from "./ProjectDetails.module.scss";

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
    on,
    off,
  } = useSocket();
  const { system: systemData, projects: allProjects, refreshProjects, refreshSystem, systemActions, startProjectAction, redeployProjectContainer, dropProjectServiceVolumes, certbotAction, issueProjectDomainSsl } = useSystem();
  const projectId = Number(id);
  const [project, setProject] = useState<Project | null>(null);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [envFiles, setEnvFiles] = useState<ProjectEnvFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [envError, setEnvError] = useState("");
  const [savingEnv, setSavingEnv] = useState(false);
  const [editingEnvId, setEditingEnvId] = useState<number | null>(null);
  const [envPath, setEnvPath] = useState("");
  const [envVariables, setEnvVariables] = useState<EnvVariable[]>([{ ...EMPTY_VARIABLE }]);
  const [importOpen, setImportOpen] = useState(false);
  const [importPath, setImportPath] = useState("");
  const [importText, setImportText] = useState("");
  const [importFileName, setImportFileName] = useState("");
  const [importError, setImportError] = useState("");
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
  const [deployLog, setDeployLog] = useState("");
  const deployLogRef = useRef<HTMLPreElement | null>(null);
  const runtimeChangedRef = useRef(false);
  const [configRepo, setConfigRepo] = useState("");
  const [configGroupName, setConfigGroupName] = useState("");
  const [configGithubCredentialId, setConfigGithubCredentialId] = useState<number | null>(null);
  const [domains, setDomains] = useState<ProjectDomain[]>([]);
  const [newDomainInput, setNewDomainInput] = useState("");
  const [newDomainService, setNewDomainService] = useState("");
  const [newDomainPort, setNewDomainPort] = useState("");
  const [addingDomain, setAddingDomain] = useState(false);
  const [domainError, setDomainError] = useState("");
  const [configHealthEndpoint, setConfigHealthEndpoint] = useState("");
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
  const [resources, setResources] = useState<ProjectResourceData | null>(null);
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
      const [projectData, credentialData, domainData] = await Promise.all([
        api.getProject(projectId),
        api.listCredentials(),
        api.listProjectDomains(projectId),
      ]);
      const envFileData = await api.listProjectEnvFiles(projectId);
      setProject(projectData);
      syncConfig(projectData);
      setDomains(domainData);
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
    setConfigIntervalS(projectData.healthCheckIntervalS);
    setConfigAutoDeployBranch(projectData.autoDeployBranch ?? "");
    setConfigNginxExtra(projectData.nginxExtraConfig ?? "");
    setConfigNginxExtraBlocks(projectData.nginxExtraBlocks ?? "");
    // Sync cached branch list from project when available
    if (projectData.branches.length > 0) setBranches(projectData.branches);
  }

  async function loadBranches() {
    if (!project?.githubRepo) return;
    setLoadingBranches(true);
    setBranchError("");
    try {
      const data = await api.getProjectBranches(project.id);
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

  function resetEnvForm() {
    setEditingEnvId(null);
    setEnvPath("");
    setEnvVariables([{ ...EMPTY_VARIABLE }]);
    setEnvError("");
    closeImportPanel();
  }

  function editEnvFile(envFile: ProjectEnvFile) {
    setEditingEnvId(envFile.id);
    setEnvPath(envFile.relativePath);
    setEnvVariables(envFile.variables.length > 0 ? envFile.variables : [{ ...EMPTY_VARIABLE }]);
    setEnvError("");
    closeImportPanel();
  }

  function newEnvFile() {
    setEditingEnvId(null);
    setEnvPath("front/.env");
    setEnvVariables([{ ...EMPTY_VARIABLE }]);
    setEnvError("");
    closeImportPanel();
  }

  function updateEnvVariable(index: number, key: keyof EnvVariable, value: string) {
    setEnvVariables((items) => items.map((item, itemIndex) => (
      itemIndex === index ? { ...item, [key]: value } : item
    )));
  }

  function removeEnvVariable(index: number) {
    setEnvVariables((items) => items.length === 1 ? [{ ...EMPTY_VARIABLE }] : items.filter((_item, itemIndex) => itemIndex !== index));
  }

  function closeImportPanel() {
    setImportOpen(false);
    setImportPath("");
    setImportText("");
    setImportFileName("");
    setImportError("");
  }

  async function readImportFile(file: File) {
    setImportFileName(file.name);
    setImportError("");
    if (!importPath && !envPath) setImportPath(file.name.endsWith(".env") ? file.name : "front/.env");
    setImportText(await file.text());
  }

  function applyEnvImport() {
    const normalizedPath = normalizeEnvRelativePath(importPath || envPath);
    if (!normalizedPath) {
      setImportError("Path must be a relative .env file and cannot contain ..");
      return;
    }
    const parsed = parseEnvText(importText);
    if (parsed.length === 0) {
      setImportError("No KEY=value pairs found to import");
      return;
    }
    setEnvPath(normalizedPath);
    setEnvVariables(parsed);
    setEnvError("");
    notify.success(`Imported ${parsed.length} variables from .env text.`);
    closeImportPanel();
  }

  async function saveEnvFile(e: React.FormEvent) {
    e.preventDefault();
    if (!project) return;
    const variables = envVariables
      .map((item) => ({ key: item.key.trim(), value: item.value }))
      .filter((item) => item.key || item.value);

    setSavingEnv(true);
    setEnvError("");
    const toastId = notify.loading(editingEnvId ? "Saving env file..." : "Creating env file...");
    try {
      const payload = { relativePath: envPath, variables };
      const saved = editingEnvId
        ? await api.updateProjectEnvFile(project.id, editingEnvId, payload)
        : await api.createProjectEnvFile(project.id, payload);
      setEnvFiles((items) => {
        if (!editingEnvId) return [...items, saved].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
        return items.map((item) => item.id === saved.id ? saved : item).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
      });
      setEditingEnvId(saved.id);
      setEnvPath(saved.relativePath);
      setEnvVariables(saved.variables.length > 0 ? saved.variables : [{ ...EMPTY_VARIABLE }]);
      notify.success(`${saved.relativePath} saved.`, { id: toastId });
    } catch (err) {
      setEnvError(err instanceof ApiError ? err.message : "Failed to save env file");
      notify.error(err, "Failed to save env file", { id: toastId });
    } finally {
      setSavingEnv(false);
    }
  }

  async function deleteEnvFile(envFile: ProjectEnvFile) {
    if (!project) return;
    const ok = await confirm({
      title: `Delete ${envFile.relativePath}?`,
      description: "This removes the saved .env configuration from this project.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    const toastId = notify.loading(`Deleting ${envFile.relativePath}...`);
    try {
      await api.deleteProjectEnvFile(project.id, envFile.id);
      setEnvFiles((items) => items.filter((item) => item.id !== envFile.id));
      if (editingEnvId === envFile.id) resetEnvForm();
      notify.success(`${envFile.relativePath} deleted.`, { id: toastId });
    } catch (err) {
      notify.error(err, "Failed to delete env file", { id: toastId });
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

  async function saveProjectConfig(e: React.FormEvent) {
    e.preventDefault();
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
      setNewDomainInput("");
      setNewDomainService("");
      setNewDomainPort("");
    } catch (err) {
      setDomainError(err instanceof ApiError ? err.message : "Failed to add domain");
    } finally {
      setAddingDomain(false);
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
      setDomains((current) => current.filter((d) => d.id !== domain.id));
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
    configIntervalS !== project.healthCheckIntervalS ||
    configAutoDeployBranch !== (project.autoDeployBranch ?? "") ||
    configNginxExtra !== (project.nginxExtraConfig ?? "") ||
    configNginxExtraBlocks !== (project.nginxExtraBlocks ?? "") ||
    configComposeFile !== (project.composeFile ?? "")
  ) : false;
  const runtimeFormId = project ? `project-runtime-${project.id}` : "project-runtime";

  function certbotRecordFor(domain: string): ActionRecord | null {
    return systemActions.certbot
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
  }, [project?.id]);

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
        if (!cancelled) setResources(data);
      }).catch(() => { /* non-critical */ });
    };
    refetch();

    const handler = (event: ProjectResourceSampleEvent) => {
      if (event.projectId !== projectId) return;
      setResources((prev) => (prev ? { ...prev, latest: event.sample } : prev));
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

  useEffect(() => {
    if (!Number.isInteger(projectId) || projectId <= 0) return;
    const handler = (event: ProjectDeployEvent) => {
      if (event.projectId !== projectId) return;

      setDeployLog((value) => value + event.message);
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
        refreshSystem();
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

  useEffect(() => {
    if (!deployLogRef.current) return;
    deployLogRef.current.scrollTop = deployLogRef.current.scrollHeight;
  }, [deployLog]);

  const certbotAvailable = !!(systemData?.certbot?.available && systemData?.certbot?.emailConfigured);
  function certbotEntryFor(domain: string) {
    return systemData?.certbot?.entries?.find((e) => e.domain === domain) ?? null;
  }
  const docker = systemData?.docker ?? null;
  const expectedStackName = project ? expectedComposeProjectName(project) : "";
  const dockerStack = (docker?.available && project) ? findProjectStack(project, docker.stacks) : null;
  const dockerRunningCount = dockerStack?.containers.filter((c) => c.state === "running").length ?? 0;
  const dockerTotalCount = dockerStack?.containers.length ?? 0;
  const dockerAllRunning = dockerTotalCount > 0 && dockerRunningCount === dockerTotalCount;
  const dockerAnyRunning = dockerRunningCount > 0;
  const dockerStackStatusClass = dockerAllRunning ? styles.statusUp : dockerAnyRunning ? styles.statusUnknown : styles.statusDown;
  const dockerStackStatus = dockerStack ? (dockerAllRunning ? "Running" : dockerAnyRunning ? "Partial" : "Stopped") : "Not found";
  const dockerPorts = dockerStack?.containers.flatMap((c) => c.ports ? [c.ports] : []) ?? [];
  const displayStatus: ProjectStatusKind = project
    ? deriveProjectStatus(project, dockerStack, docker?.available ?? false)
    : "not-deployed";
  const displayStatusReason = project
    ? explainProjectStatus(project, dockerStack, docker?.available ?? false, displayStatus)
    : "";
  const selectedEnvFile = editingEnvId != null ? envFiles.find((file) => file.id === editingEnvId) ?? null : null;
  const filledEnvVariables = envVariables.filter((variable) => variable.key.trim() || variable.value.trim());
  const envDraftChanged = selectedEnvFile
    ? envPath !== selectedEnvFile.relativePath || JSON.stringify(envVariables) !== JSON.stringify(selectedEnvFile.variables.length > 0 ? selectedEnvFile.variables : [{ ...EMPTY_VARIABLE }])
    : !!envPath || filledEnvVariables.length > 0;

  return (
    <>
      <main className="main">
        <div className="page-title" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <FolderDot size={20} />
            {project?.name ?? "Project"}
          </span>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {project && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={styles.dangerAction}
                onClick={() => void deleteCurrentProject()}
                disabled={deletingProject}
              >
                {deletingProject ? <Loader size={13} className="spin" /> : <Trash2 size={13} />}
                Delete
              </Button>
            )}
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
                <div className={styles.statusActions}>
                  {project.sourceType === "github" && (
                    <>
                      <AppSelect
                        value={pullBranch}
                        onValueChange={setPullBranch}
                        disabled={pullingRepo || deploying || composingProject || recreatingProject || forceRebuilding || stoppingProject || project.paused}
                        options={[
                          { value: "", label: "Current branch" },
                          ...branches.map((b) => ({ value: b.name, label: b.name })),
                        ]}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void runProjectCommand("pull", pullBranch ? { branch: pullBranch } : undefined)}
                        disabled={pullingRepo || deploying || composingProject || recreatingProject || forceRebuilding || stoppingProject || !project.githubRepo || project.paused}
                        title={pullBranch ? `Pull and switch to ${pullBranch}` : "Pull the currently checked-out branch"}
                      >
                        {pullingRepo ? <Loader size={13} className="spin" /> : <GitBranch size={13} />}
                        Pull from GitHub
                      </Button>
                    </>
                  )}
                  {project.sourceType === "upload" && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setReuploadOpen((open) => !open)}
                      disabled={uploadingFiles || deploying || composingProject || recreatingProject || forceRebuilding || stoppingProject || project.paused}
                    >
                      {uploadingFiles ? <Loader size={13} className="spin" /> : <Upload size={13} />}
                      Re-upload files
                    </Button>
                  )}
                  <Button
                    type="button"
                    onClick={() => void runProjectCommand("compose")}
                    disabled={composingProject || recreatingProject || forceRebuilding || deploying || pullingRepo || stoppingProject || (project.sourceType === "github" && !project.githubRepo) || project.paused}
                  >
                    {composingProject ? <Loader size={13} className="spin" /> : <Box size={13} />}
                    Docker Compose
                  </Button>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button type="button" variant="outline">
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
                    </PopoverContent>
                  </Popover>
                </div>
              </div>

              {(project.lastCommitSha || project.lastCommitAt) && (
                <div className={styles.commitInfo}>
                  {project.lastCommitSha && (
                    <span className={cn("mono", styles.commitSha)}>{project.lastCommitSha.slice(0, 7)}</span>
                  )}
                  {project.lastCommitMessage && (
                    <span className={styles.commitMsg}>{project.lastCommitMessage}</span>
                  )}
                  {project.lastCommitAuthor && (
                    <span className={cn("mono", styles.commitMeta)}>{project.lastCommitAuthor}</span>
                  )}
                  {project.lastCommitAt && (
                    <span className={cn("mono", styles.commitMeta)}>{formatShortDateTime(project.lastCommitAt, "")}</span>
                  )}
                </div>
              )}

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

              {(deployLog || deployOk !== null) && (
                <pre ref={deployLogRef} className={`output-block${deployOk === false ? " output-stderr" : ""}`}>
                  {deployLog || (deployOk ? "Command completed" : "Command failed")}
                </pre>
              )}
            </div>

            {/* ── Docker expandable card ───────────────────────────────── */}
            <ExpandableCard
              icon={<Box size={13} />}
              title="Docker"
              summary={
                systemData === null ? (
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
                <div className="alert alert-error">{docker?.reason ?? "Docker unavailable"}</div>
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

            {/* ── Project config card ──────────────────────────────────── */}
            <div className={cn("card", styles.runtimeCard)}>
              <div className="card-title">
                Project Config
                <Button
                  type="submit"
                  form={runtimeFormId}
                  size="xs"
                  style={{ marginLeft: "auto" }}
                  disabled={savingConfig || !runtimeChanged}
                >
                  {savingConfig ? <Loader size={12} className="spin" /> : <Save size={12} />}
                  Save
                </Button>
              </div>
              {configError && <div className="alert alert-error">{configError}</div>}

              <form id={runtimeFormId} className={styles.runtimeForm} onSubmit={(e) => void saveProjectConfig(e)}>
                <ProjectGroupField value={configGroupName} onValueChange={setConfigGroupName} projects={allProjects ?? []} disabled={savingConfig} />
                <div className={styles.runtimeSection}>
                  <div className={styles.runtimeSectionHeader}>
                    <span>Repository</span>
                  </div>
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
                      <span className="hint"> (poller triggers deploy on new commits)</span>
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
                </div>

                <div className={styles.runtimeSection}>
                  <div className={styles.runtimeSectionHeader}>
                    <span>Ingress</span>
                  </div>
                  <div className="field field-wide" style={{ gridColumn: "1 / -1" }}>
                    <label>Domains <span className="hint">(each domain routes to its own compose service + container port over the stackport-proxy network)</span></label>
                    <div className="row-actions" style={{ marginBottom: domains.length > 0 ? 10 : 0 }}>
                      <Input
                        type="text"
                        placeholder="myapp.example.com"
                        value={newDomainInput}
                        onChange={(e) => setNewDomainInput(e.target.value)}
                        style={{ maxWidth: 220 }}
                      />
                      <ProjectIngressSelect projectId={project.id} composeFile={project.composeFile}
                        refreshKey={project.updatedAt} disabled={addingDomain}
                        value={newDomainService && newDomainPort ? `${newDomainService}:${newDomainPort}` : ""}
                        onValueChange={value => { const [service = "", port = ""] = value.split(":"); setNewDomainService(service); setNewDomainPort(port); }} />
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        onClick={() => void addDomain()}
                        disabled={addingDomain || !newDomainInput.trim() || !newDomainService.trim() || !newDomainPort.trim()}
                      >
                        {addingDomain ? <Loader size={12} className="spin" /> : <Plus size={12} />}
                        Add
                      </Button>
                    </div>
                    {domainError && <div style={{ fontSize: "0.78rem", color: "var(--danger)", marginBottom: 8 }}>{domainError}</div>}
                    {domains.length === 0 ? (
                      <div className="muted-text" style={{ fontSize: 13 }}>No domains routed to this project.</div>
                    ) : (
                      <div style={{ display: "grid", gap: 8 }}>
                        {domains.map((domain) => {
                          const entry = certbotEntryFor(domain.domain);
                          const record = certbotRecordFor(domain.domain);
                          const acting = record?.status === "running";
                          return (
                            <div key={domain.id} className={cn(styles.runtimeSection, styles.certSection)} style={{ marginBottom: 0 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                                <span className="mono" style={{ fontSize: 13 }}>{domain.domain}</span>
                                <span className="mono muted-text" style={{ fontSize: 11 }}>
                                  {domain.service ? `${domain.service}:${domain.containerPort}` : "not routed"}
                                </span>
                                {entry ? (
                                  <span className={cn(styles.statusPill,
                                    entry.status === "valid" ? styles.statusUp :
                                    entry.status === "expiring" ? styles.statusUnknown :
                                    styles.statusDown
                                  )} style={{ fontSize: 11 }}>
                                    {entry.status}
                                    {entry.expiresAt && ` · ${formatShortDateTime(entry.expiresAt, "")}`}
                                  </span>
                                ) : (
                                  <span className={cn(styles.statusPill, styles.statusDown)} style={{ fontSize: 11 }}>no cert</span>
                                )}
                                <label style={{ display: "inline-flex", alignItems: "center", gap: 6, marginLeft: "auto", cursor: certbotAvailable ? "pointer" : "not-allowed", opacity: certbotAvailable ? 1 : 0.55 }}>
                                  <Switch
                                    checked={domain.useSsl}
                                    onCheckedChange={(checked) => void toggleDomainSsl(domain, checked)}
                                    disabled={!certbotAvailable}
                                  />
                                  <span style={{ fontSize: 12 }}>Use SSL</span>
                                </label>
                              </div>
                              <div className="row-actions" style={{ gridColumn: "1 / -1" }}>
                                {certbotAvailable && (!entry || entry.status === "missing" || entry.status === "expired") ? (
                                  <Button type="button" size="xs" onClick={() => void issueDomainSsl(domain)} disabled={acting}>
                                    {acting ? <Loader size={12} className="spin" /> : <Lock size={12} />}
                                    Issue cert
                                  </Button>
                                ) : certbotAvailable && (
                                  <Button type="button" variant="outline" size="xs" onClick={() => void handleCertAction(domain.domain, "renew")} disabled={acting}>
                                    {acting ? <Loader size={12} className="spin" /> : <RefreshCw size={12} />}
                                    Renew
                                  </Button>
                                )}
                                {entry && (
                                  <Button type="button" variant="outline" size="xs" className={styles.dangerAction} onClick={() => void handleCertAction(domain.domain, "delete")} disabled={acting}>
                                    <Trash2 size={12} />
                                    Remove cert
                                  </Button>
                                )}
                                <Button type="button" variant="outline" size="xs" className={styles.dangerAction} onClick={() => void removeDomainRow(domain)}>
                                  <Trash2 size={12} />
                                  Remove domain
                                </Button>
                              </div>
                              {record?.log && (
                                <pre className="output-block" style={{ gridColumn: "1 / -1", marginTop: 4 }}>{record.log}</pre>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
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
                </div>

                <div className={styles.runtimeSection}>
                  <div className={styles.runtimeSectionHeader}>
                    <span>Deployment history</span>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={() => void handleRollback()}
                      disabled={rollingBack || revisions.filter((r) => r.status !== "failed").length < 2}
                      title="Restore the previous successful revision's exact commit and compose file, then redeploy"
                    >
                      {rollingBack ? <Loader size={12} className="spin" /> : <RotateCw size={12} />}
                      Roll back
                    </Button>
                  </div>
                  {revisions.length === 0 ? (
                    <div className="muted-text" style={{ fontSize: 13 }}>No recorded deployments yet.</div>
                  ) : (
                    <div style={{ display: "grid", gap: 4 }}>
                      {revisions.slice(0, 8).map((rev) => (
                        <div key={rev.id} className="row-actions" style={{ fontSize: 12, gap: 10 }}>
                          <span
                            className={cn(styles.statusPill,
                              rev.status === "active" ? styles.statusUp :
                              rev.status === "failed" ? styles.statusDown :
                              styles.statusUnknown
                            )}
                            style={{ fontSize: 11 }}
                          >
                            {rev.status}
                          </span>
                          <span className="mono">{rev.commitSha ? rev.commitSha.slice(0, 7) : "—"}</span>
                          <span className="muted-text">{rev.composeFileName ?? ""}</span>
                          <span className="muted-text" style={{ marginLeft: "auto" }}>{formatShortDateTime(rev.createdAt)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className={styles.runtimeSection}>
                  <div className={styles.runtimeSectionHeader}>
                    <span>Health check</span>
                  </div>
                  <div className="field">
                    <label>Endpoint</label>
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
                </div>

              </form>
            </div>

            {project.githubRepo && (
              <div className="card">
                <div className="card-title">
                  <GitBranch size={13} />
                  GitHub
                  <div className="row-actions" style={{ marginLeft: "auto" }}>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => void loadBranches()}
                      disabled={loadingBranches}
                    >
                      {loadingBranches ? <Loader size={12} className="spin" /> : <RefreshCw size={12} />}
                      Refresh branches
                    </button>
                  </div>
                </div>

                <div className={styles.detailGrid}>
                  <DetailRow label="Repository" value={<a className="ext-link mono" href={`https://github.com/${project.githubRepo}`} target="_blank" rel="noopener noreferrer">{project.githubRepo} <ExternalLink size={10} /></a>} />
                  <DetailRow label="Auto-deploy branch" value={project.autoDeployBranch ? <span className="mono">{project.autoDeployBranch}</span> : <span className="muted-text">Off</span>} />
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
                  <div style={{ marginTop: 12 }}>
                    <div style={{ fontSize: "0.78rem", color: "var(--dim)", marginBottom: 6 }}>Branches</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {branches.map((b) => (
                        <div key={b.name} style={{ display: "flex", gap: 10, alignItems: "baseline", fontSize: "0.82rem" }}>
                          <span className="mono" style={{ minWidth: 140, color: b.name === project.autoDeployBranch ? "var(--primary)" : "inherit" }}>
                            <GitCommit size={11} style={{ marginRight: 4 }} />
                            {b.name}
                            {b.name === project.autoDeployBranch && <span style={{ marginLeft: 4, fontSize: "0.75em", color: "var(--primary)" }}>▶ auto-deploy</span>}
                          </span>
                          {b.commitMessage && <span style={{ color: "var(--dim)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.commitMessage}</span>}
                          {b.commitAuthor && <span className="mono" style={{ color: "var(--dim)", fontSize: "0.78em" }}>{b.commitAuthor}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {deploys.length > 0 && (
                  <div style={{ marginTop: 16 }}>
                    <div style={{ fontSize: "0.78rem", color: "var(--dim)", marginBottom: 6 }}>Recent deploys</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                      {deploys.slice(0, 10).map((d) => (
                        <div key={d.id} style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: "0.8rem" }}>
                          <span className="mono" style={{ fontSize: "0.76em", color: "var(--dim)", minWidth: 130 }}>{formatShortDateTime(d.createdAt, "")}</span>
                          <span style={{
                            fontSize: "0.74em",
                            padding: "1px 6px",
                            borderRadius: 4,
                            background: d.status === "success" ? "var(--success-bg, rgba(34,197,94,0.12))" : d.status === "failed" ? "var(--danger-bg, rgba(239,68,68,0.12))" : "var(--bg-3)",
                            color: d.status === "success" ? "var(--success, #22c55e)" : d.status === "failed" ? "var(--danger)" : "var(--dim)",
                          }}>{d.status}</span>
                          <span style={{ fontSize: "0.74em", color: "var(--dim)" }}>{d.triggeredBy === "auto" ? "auto" : "manual"}</span>
                          {d.commitSha && <span className="mono" style={{ fontSize: "0.74em", color: "var(--dim)" }}>{d.commitSha.slice(0, 7)}</span>}
                          {d.commitMessage && <span style={{ color: "var(--dim)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.commitMessage}</span>}
                        </div>
                      ))}
                    </div>
                    {loadingDeploys && <Loader size={12} className="spin" style={{ marginTop: 6 }} />}
                  </div>
                )}
              </div>
            )}

            <div className="card">
              <div className="card-title">
                <Activity size={13} />
                Resource usage
                <span className="muted-text" style={{ fontWeight: 400, marginLeft: 4 }}>5-min avg, last 24h</span>
              </div>
              <div className={styles.detailGrid} style={{ marginBottom: 12 }}>
                <DetailRow label="CPU" value={resources?.latest ? `${resources.latest.cpuPercent.toFixed(1)}%` : "—"} />
                <DetailRow
                  label="Memory"
                  value={resources?.latest
                    ? `${resources.latest.memPercent.toFixed(1)}% (${Math.round(resources.latest.memUsedMb)} MB / ${Math.round(resources.latest.memLimitMb)} MB)`
                    : "—"}
                />
              </div>
              <ProjectResourceCharts resources={resources} chartHeight={180} />
            </div>

            <div className={cn("card", styles.envCard)}>
              <div className={styles.envCardHeader}>
                <div className="card-title">
                  <FileText size={13} />
                  Env Files
                  <span className={styles.envCount}>{envFiles.length}</span>
                  {envDraftChanged && <span className={styles.envUnsaved}>Unsaved</span>}
                </div>
                <div className="row-actions">
                  <Button type="button" variant="outline" size="xs" onClick={newEnvFile}>
                    <Plus size={12} />
                    New
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => {
                      if (!importOpen && !importPath) setImportPath(envPath || "front/.env");
                      setImportOpen((open) => !open);
                    }}
                  >
                    <Upload size={12} />
                    Import
                  </Button>
                </div>
              </div>

              {envError && <div className="alert alert-error">{envError}</div>}

              <div className={styles.envWorkspace}>
                <aside className={styles.envFileRail}>
                  <div className={styles.envRailHeader}>
                    <span>Configured</span>
                    <span>{envFiles.reduce((total, file) => total + file.variables.length, 0)} vars</span>
                  </div>
                  {envFiles.length === 0 ? (
                    <div className={styles.envRailEmpty}>No files yet.</div>
                  ) : envFiles.map((envFile) => (
                    <button
                      type="button"
                      className={cn(styles.envFileButton, editingEnvId === envFile.id && styles.envFileButtonActive)}
                      key={envFile.id}
                      onClick={() => editEnvFile(envFile)}
                    >
                      <span className={styles.envFileName}>
                        <FileText size={13} />
                        <span>{envFile.relativePath}</span>
                      </span>
                      <span className={styles.envFileMeta}>{envFile.variables.length} variables</span>
                    </button>
                  ))}
                </aside>

                <form onSubmit={(e) => void saveEnvFile(e)} className={styles.envEditorPanel}>
                  <div className={styles.envEditorTopbar}>
                    <div>
                      <div className={styles.envEditorTitle}>{selectedEnvFile ? selectedEnvFile.relativePath : "New env file"}</div>
                      <div className="muted-text">{filledEnvVariables.length} populated variables</div>
                    </div>
                    {selectedEnvFile && (
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        className={styles.envDeleteButton}
                        onClick={() => void deleteEnvFile(selectedEnvFile)}
                      >
                        <Trash2 size={12} />
                        Delete
                      </Button>
                    )}
                  </div>

                  <div className={styles.envPathRow}>
                    <div className="field field-wide">
                      <label>Path</label>
                      <Input
                        type="text"
                        placeholder="front/.env"
                        value={envPath}
                        onChange={(e) => setEnvPath(e.target.value)}
                        required
                      />
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={() => setEnvVariables((items) => [...items, { ...EMPTY_VARIABLE }])}
                    >
                      <Plus size={12} />
                      Variable
                    </Button>
                  </div>

                  {importOpen && (
                    <div className={styles.envImportPanel}>
                      {importError && <div className="alert alert-error">{importError}</div>}
                      <div className={styles.envImportGrid}>
                        <div className="field">
                          <label>Import path</label>
                          <Input
                            type="text"
                            placeholder="front/.env"
                            value={importPath}
                            onChange={(e) => setImportPath(e.target.value)}
                          />
                        </div>
                        <label
                          className={styles.envDropZone}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={(e) => {
                            e.preventDefault();
                            const file = e.dataTransfer.files[0];
                            if (file) void readImportFile(file);
                          }}
                        >
                          <input
                            type="file"
                            accept=".env,text/plain"
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) void readImportFile(file);
                            }}
                          />
                          <Upload size={14} />
                          <span>{importFileName || "Drop .env"}</span>
                        </label>
                      </div>
                      <textarea
                        className={styles.envImportTextarea}
                        placeholder={"API_URL=https://example.com\nNODE_ENV=production"}
                        value={importText}
                        onChange={(e) => setImportText(e.target.value)}
                      />
                      <div className={styles.envImportActions}>
                        <Button type="button" variant="ghost" size="xs" onClick={closeImportPanel}>
                          Cancel
                        </Button>
                        <Button type="button" size="xs" onClick={applyEnvImport} disabled={!importText.trim()}>
                          Parse
                        </Button>
                      </div>
                    </div>
                  )}

                  <div className={styles.envVarTable}>
                    <div className={styles.envVarHeader}>
                      <span>Key</span>
                      <span>Value</span>
                      <span />
                    </div>
                    {envVariables.map((variable, index) => (
                      <div className={styles.envVarRow} key={index}>
                        <Input
                          type="text"
                          placeholder="KEY"
                          value={variable.key}
                          onChange={(e) => updateEnvVariable(index, "key", e.target.value)}
                        />
                        <Input
                          type="text"
                          placeholder="value"
                          value={variable.value}
                          onChange={(e) => updateEnvVariable(index, "value", e.target.value)}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => removeEnvVariable(index)}
                          title="Remove variable"
                        >
                          <X size={13} />
                        </Button>
                      </div>
                    ))}
                  </div>

                  <div className={styles.envEditorActions}>
                    <Button type="button" variant="outline" size="xs" onClick={resetEnvForm} disabled={!envDraftChanged && !editingEnvId}>
                      <X size={12} />
                      Clear
                    </Button>
                    <Button type="submit" size="xs" disabled={savingEnv || !envPath.trim()}>
                      {savingEnv ? <Loader size={12} className="spin" /> : <Save size={12} />}
                      {editingEnvId ? "Save" : "Create"}
                    </Button>
                  </div>
                </form>
              </div>
            </div>

            <div className="card">
              <div className="card-title">
                <GitBranch size={13} />
                Project Metadata
              </div>
              <div className={styles.detailGrid}>
                <DetailRow label="Project ID" value={<span className="mono">{project.id}</span>} />
                <DetailRow label="Created" value={<span className="mono">{formatShortDateTime(project.createdAt)}</span>} />
                <DetailRow label="Updated" value={<span className="mono">{formatShortDateTime(project.updatedAt)}</span>} />
              </div>
            </div>
          </>
        ) : null}

      </main>
      {shellContainer && (
        <ContainerShellDialog container={shellContainer} onClose={() => setShellContainer(null)} />
      )}
      {logStreamContainer && (
        <ContainerLogDialog container={logStreamContainer} onClose={() => setLogStreamContainer(null)} />
      )}
      {composeFileDialogOpen && project && (
        <ComposeFileDialog projectId={project.id} projectName={project.name} onClose={() => setComposeFileDialogOpen(false)} />
      )}
    </>
  );
}
