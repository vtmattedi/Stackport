import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowRight,
  CheckCircle,
  FileText,
  FolderDot,
  GitBranch,
  Globe,
  KeyRound,
  Loader,
  Lock,
  Plus,
  RefreshCw,
  Save,
  Server,
  Star,
  Settings2,
  TerminalSquare,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { ActionSelect, AppSelect } from "../components/AppSelect";
import { ProjectGroupField } from "../components/ProjectGroupField";
import { ProjectIngressSelect } from "../components/ProjectIngressSelect";
import { GitHubTokenSelect } from "../components/GitHubTokenSelect";
import { Switch } from "../components/ui/switch";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { useConfirm } from "../components/ConfirmDialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { api, ApiError } from "../api/client";
import type { Credential, EnvVariable, GitHubBranch, Project, ProjectDeployEvent, ProjectEnvFile } from "../api/types";
import { useSocket } from "../context/SocketContext";
import { pollProjectAction, useSystem } from "../context/SystemContext";
import { deriveProjectStatus, explainProjectStatus, findProjectStack, projectStatusLabel, type ProjectStatusKind } from "../lib/projectStatus";
import { notify } from "../lib/notify";
import { EMPTY_VARIABLE, normalizeEnvRelativePath, parseEnvText } from "../lib/env";
import { cn } from "../lib/utils";
import envStyles from "./ProjectDetails.module.scss";

const WIZARD_STEPS = [
  { id: 1, label: "Repo info", icon: GitBranch },
  { id: 2, label: "Pull repo", icon: TerminalSquare },
  { id: 3, label: "Env files", icon: FileText },
  { id: 4, label: "Build", icon: Server },
  { id: 5, label: "Project config", icon: Settings2 },
  { id: 6, label: "Finished", icon: CheckCircle },
] as const;

type WizardStepId = typeof WIZARD_STEPS[number]["id"];
type StageStatus = "idle" | "running" | "success" | "failed";
type WizardSource = "github" | "upload";

interface WizardStepDef {
  id: WizardStepId;
  label: string;
  icon: ComponentType<{ size?: number }>;
}

interface WizardSupportFile {
  file: File | null;
  path: string;
}

const STATUS_DOT_COLOR: Record<ProjectStatusKind, string> = {
  ready: "var(--success)",
  down: "var(--danger)",
  problem: "#e6a817",
  "not-deployed": "var(--dim)",
  paused: "#e6a817",
};

function StatusDot({ status, reason }: { status: ProjectStatusKind; reason: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="status-dot"
          style={{ background: STATUS_DOT_COLOR[status], opacity: status === "not-deployed" ? 0.5 : 1 }}
        />
      </TooltipTrigger>
      <TooltipContent side="top">{reason}</TooltipContent>
    </Tooltip>
  );
}

function githubTokenLabel(project: Project, githubCredentials: Credential[]): string {
  if (project.githubCredentialId) {
    const credential = githubCredentials.find((item) => item.id === project.githubCredentialId);
    return credential ? `GitHub token: ${credential.alias}` : `GitHub token: #${project.githubCredentialId}`;
  }
  const defaultCredential = githubCredentials.find((item) => item.isDefault);
  return defaultCredential ? `GitHub token: ${defaultCredential.alias} (default)` : "No GitHub token selected";
}

function WizardTimeline({ currentStep, statusByStep, steps = WIZARD_STEPS }: { currentStep: WizardStepId; statusByStep: Record<WizardStepId, StageStatus>; steps?: readonly WizardStepDef[] }) {
  return (
    <TooltipProvider>
      <div className="wizard-timeline" aria-label="Project creation progress">
        {steps.map((step, index) => {
          const status = statusByStep[step.id];
          const active = step.id === currentStep;
          const done = status === "success";
          const failed = status === "failed";
          return (
            <div key={step.id} className="wizard-timeline-item-wrap">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className={`wizard-timeline-item${active ? " wizard-timeline-active" : ""}${done ? " wizard-timeline-done" : ""}${failed ? " wizard-timeline-failed" : ""}`}
                    tabIndex={0}
                  >
                    {status === "running" ? <Loader size={12} className="spin" /> : done ? <CheckCircle size={12} /> : failed ? <X size={12} /> : index + 1}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">{step.label}</TooltipContent>
              </Tooltip>
              {index < steps.length - 1 && <span className={`wizard-timeline-line${done ? " wizard-timeline-line-done" : ""}`} />}
            </div>
          );
        })}
      </div>
    </TooltipProvider>
  );
}

function WizardScreen({ title, description, icon, children }: { title: string; description: string; icon: ReactNode; children: ReactNode }) {
  return (
    <div className="wizard-screen">
      <div className="wizard-screen-heading">
        <span className="wizard-screen-icon">{icon}</span>
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

export default function Projects() {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { subscribeDeploy, unsubscribeDeploy } = useSocket();
  const { projects: projectsData, refreshProjects: refresh, startProjectAction, issueProjectDomainSsl, system } = useSystem();
  const projects = projectsData ?? [];
  const loading = projectsData === null;
  const [groupFilter, setGroupFilter] = useState("");
  const groupNames = [...new Set(projects.map(project => project.groupName).filter((name): name is string => !!name))].sort((a, b) => a.localeCompare(b));
  const visibleProjects = projects.filter(project => !groupFilter || (groupFilter === "ungrouped" ? !project.groupName : project.groupName === groupFilter.slice(6)));
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const githubCredentials = credentials.filter((credential) => credential.type === "github");
  const [togglingFavoriteId, setTogglingFavoriteId] = useState<number | null>(null);

  async function toggleFavorite(p: Project) {
    setTogglingFavoriteId(p.id);
    try {
      if (p.favorite) await api.unfavoriteProject(p.id);
      else await api.favoriteProject(p.id);
      refresh();
    } catch (err) {
      notify.error(err, p.favorite ? `Failed to unfavorite ${p.name}` : `Failed to favorite ${p.name}`);
    } finally {
      setTogglingFavoriteId(null);
    }
  }

  const [modalOpen, setModalOpen] = useState(false);
  const [wizardStep, setWizardStep] = useState<WizardStepId>(1);
  const [wizardSource, setWizardSource] = useState<WizardSource>("github");
  const [wizardName, setWizardName] = useState("");
  const [wizardGroupName, setWizardGroupName] = useState("");
  const [wizardRepo, setWizardRepo] = useState("");
  const [wizardGithubCredentialId, setWizardGithubCredentialId] = useState<number | null>(null);
  const [createdProject, setCreatedProject] = useState<Project | null>(null);
  const [composeFiles, setComposeFiles] = useState<string[]>([]);
  const [wizardComposeFileChoice, setWizardComposeFileChoice] = useState("");
  const [branches, setBranches] = useState<GitHubBranch[]>([]);
  const [pullBranch, setPullBranch] = useState("");
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [wizardDomain, setWizardDomain] = useState("");
  const [wizardDomainService, setWizardDomainService] = useState("");
  const [wizardDomainPort, setWizardDomainPort] = useState("");
  const [wizardAutoDeployBranch, setWizardAutoDeployBranch] = useState("");
  const [wizardUseSsl, setWizardUseSsl] = useState(false);
  const [wizardError, setWizardError] = useState("");
  const [pullLog, setPullLog] = useState("");
  const [composeLog, setComposeLog] = useState("");
  const [uploadLog, setUploadLog] = useState("");
  const [uploadStatus, setUploadStatus] = useState<StageStatus>("idle");
  const [wizardComposeFile, setWizardComposeFile] = useState<File | null>(null);
  const [wizardSupportFiles, setWizardSupportFiles] = useState<WizardSupportFile[]>([]);
  const [nginxLog, setNginxLog] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [pullStatus, setPullStatus] = useState<StageStatus>("idle");
  const [composeStatus, setComposeStatus] = useState<StageStatus>("idle");
  const [configStatus, setConfigStatus] = useState<StageStatus>("idle");
  const [sslReady, setSslReady] = useState(false);
  const [envFiles, setEnvFiles] = useState<ProjectEnvFile[]>([]);
  const [envEditingId, setEnvEditingId] = useState<number | null>(null);
  const [envPath, setEnvPath] = useState("");
  const [envVariables, setEnvVariables] = useState<EnvVariable[]>([{ ...EMPTY_VARIABLE }]);
  const [envError, setEnvError] = useState("");
  const [savingEnv, setSavingEnv] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importPath, setImportPath] = useState("");
  const [importText, setImportText] = useState("");
  const [importFileName, setImportFileName] = useState("");
  const [importError, setImportError] = useState("");
  const modalRunIdRef = useRef(0);

  useEffect(() => {
    void api.listCredentials().then(setCredentials);
  }, []);

  const selectedEnvFile = envEditingId != null ? envFiles.find((file) => file.id === envEditingId) ?? null : null;
  const filledEnvVariables = envVariables.filter((variable) => variable.key.trim() || variable.value.trim());
  const envDraftChanged = selectedEnvFile
    ? envPath !== selectedEnvFile.relativePath || JSON.stringify(envVariables) !== JSON.stringify(selectedEnvFile.variables.length > 0 ? selectedEnvFile.variables : [{ ...EMPTY_VARIABLE }])
    : !!envPath || filledEnvVariables.length > 0;

  const statusByStep: Record<WizardStepId, StageStatus> = {
    1: createdProject ? "success" : creatingProject ? "running" : "idle",
    2: wizardSource === "upload" ? uploadStatus : pullStatus,
    3: wizardStep > 3 ? "success" : "idle",
    4: composeStatus,
    5: configStatus,
    6: wizardStep === 6 ? "success" : "idle",
  };

  const wizardSteps: readonly WizardStepDef[] = wizardSource === "upload"
    ? WIZARD_STEPS.filter((step) => step.id !== 4).map((step) => (step.id === 2 ? { ...step, label: "Upload files", icon: Upload } : step))
    : WIZARD_STEPS;

  function resetWizard() {
    modalRunIdRef.current += 1;
    setWizardStep(1);
    setWizardSource("github");
    setWizardName("");
    setWizardGroupName("");
    setWizardRepo("");
    setWizardGithubCredentialId(null);
    setCreatedProject(null);
    setComposeFiles([]);
    setWizardComposeFileChoice("");
    setBranches([]);
    setPullBranch("");
    setLoadingBranches(false);
    setWizardDomain("");
    setWizardAutoDeployBranch("");
    setWizardUseSsl(false);
    setWizardError("");
    setPullLog("");
    setComposeLog("");
    setUploadLog("");
    setUploadStatus("idle");
    setWizardComposeFile(null);
    setWizardSupportFiles([]);
    setNginxLog("");
    setCreatingProject(false);
    setPullStatus("idle");
    setComposeStatus("idle");
    setConfigStatus("idle");
    setSslReady(false);
    setEnvFiles([]);
    resetEnvForm();
  }

  function openWizard() {
    resetWizard();
    setModalOpen(true);
  }

  function closeWizard() {
    if (creatingProject || pullStatus === "running" || composeStatus === "running" || configStatus === "running" || uploadStatus === "running") return;
    setModalOpen(false);
    resetWizard();
  }

  async function loadRepoMetadata(projectId: number) {
    const [projectData, branchData, systemData] = await Promise.all([
      api.getProject(projectId).catch((err) => {
        setWizardError(err instanceof ApiError ? err.message : "Failed to load project");
        return null;
      }),
      api.getProjectBranches(projectId).catch(() => ({ branches: [] as GitHubBranch[], autoDeployBranch: null })),
      api.getSystem().catch(() => null),
    ]);

    if (projectData) {
      setCreatedProject(projectData);
      setComposeFiles(projectData.availableComposeFiles);
      setWizardComposeFileChoice(projectData.composeFile ?? "");
    }
    setBranches(branchData.branches);
    setWizardAutoDeployBranch((current) => current || branchData.autoDeployBranch || "");
    setSslReady(!!(systemData?.certbot?.available && systemData.certbot.emailConfigured));
  }

  async function loadWizardBranches(projectId: number) {
    setLoadingBranches(true);
    try {
      const data = await api.getProjectBranches(projectId);
      setBranches(data.branches);
      setWizardAutoDeployBranch((current) => current || data.autoDeployBranch || "");
    } catch (err) {
      setWizardError(err instanceof ApiError ? err.message : "Failed to load branches");
    } finally {
      setLoadingBranches(false);
    }
  }

  async function runPull(project: Project, runId = modalRunIdRef.current, branch = pullBranch) {
    setPullStatus("running");
    setWizardError("");
    setPullLog(branch ? `Starting GitHub pull (branch: ${branch})...\n` : "Starting GitHub pull...\n");
    setComposeStatus("idle");
    setComposeLog("");
    try {
      const final = await startProjectAction(project.id, "pull", branch ? { branch } : undefined);
      if (modalRunIdRef.current !== runId) return;
      if (final?.log) setPullLog(final.log);
      if (!final || !final.ok) {
        setPullStatus("failed");
        setWizardError("Git pull failed. Review the command output and retry.");
        return;
      }
      setPullStatus("success");
      await loadRepoMetadata(project.id);
    } catch (err) {
      if (modalRunIdRef.current !== runId) return;
      setPullStatus("failed");
      setWizardError(err instanceof ApiError ? err.message : "Git pull failed");
    }
  }

  async function createProjectAndStartPull(e: React.FormEvent) {
    e.preventDefault();
    const runId = modalRunIdRef.current + 1;
    modalRunIdRef.current = runId;
    setWizardError("");
    setCreatingProject(true);
    setPullLog("");
    try {
      const project = wizardSource === "upload"
        ? await api.createProject({ name: wizardName, groupName: wizardGroupName.trim() || null, sourceType: "upload" })
        : await api.createProject({
          groupName: wizardGroupName.trim() || null,
          name: wizardName,
          githubRepo: wizardRepo,
          githubCredentialId: wizardGithubCredentialId ?? undefined,
        });
      if (modalRunIdRef.current !== runId) return;
      setCreatedProject(project);
      setWizardStep(2);
      setCreatingProject(false);
      refresh();
      notify.success(`${project.name} created.`);
      if (wizardSource === "github") void loadWizardBranches(project.id);
    } catch (err) {
      if (modalRunIdRef.current !== runId) return;
      setWizardError(err instanceof ApiError ? err.message : "Failed to create project");
      setCreatingProject(false);
    }
  }

  async function runUpload(project: Project, runId = modalRunIdRef.current) {
    if (!wizardComposeFile) {
      setWizardError("Choose a docker-compose.yml file first.");
      return;
    }
    setUploadStatus("running");
    setComposeStatus("running");
    setWizardError("");
    setUploadLog("Uploading files...\n");
    setComposeLog("");
    try {
      const supportFiles = wizardSupportFiles
        .filter((f): f is { file: File; path: string } => f.file !== null && f.path.trim().length > 0)
        .map((f) => ({ file: f.file, path: f.path.trim() }));
      const started = await api.uploadProjectCompose(project.id, wizardComposeFile, supportFiles);
      if (!started.started) {
        if (modalRunIdRef.current !== runId) return;
        setUploadStatus("failed");
        setComposeStatus("failed");
        setWizardError(started.error ?? "An action is already running for this project");
        return;
      }
      const final = await pollProjectAction(project.id, "repo");
      if (modalRunIdRef.current !== runId) return;
      if (!final || !final.ok) {
        setUploadStatus("failed");
        setComposeStatus("failed");
        setWizardError("Upload or docker compose failed. Review the command output and retry.");
        return;
      }
      setUploadStatus("success");
      setComposeStatus("success");
      await loadRepoMetadata(project.id);
      setWizardStep(3);
    } catch (err) {
      if (modalRunIdRef.current !== runId) return;
      setUploadStatus("failed");
      setComposeStatus("failed");
      setWizardError(err instanceof ApiError ? err.message : "Upload failed");
    }
  }

  function addSupportFile() {
    setWizardSupportFiles((files) => [...files, { file: null, path: "" }]);
  }

  function updateSupportFile(index: number, patch: Partial<WizardSupportFile>) {
    setWizardSupportFiles((files) => files.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  }

  function removeSupportFile(index: number) {
    setWizardSupportFiles((files) => files.filter((_, i) => i !== index));
  }

  async function retryPull() {
    if (!createdProject) return;
    const runId = modalRunIdRef.current + 1;
    modalRunIdRef.current = runId;
    await runPull(createdProject, runId);
  }

  async function runComposeBuild() {
    if (!createdProject || pullStatus !== "success") return;
    setComposeStatus("running");
    setWizardError("");
    setComposeLog("Starting docker compose build...\n");
    try {
      const final = await startProjectAction(createdProject.id, "compose");
      if (final?.log) setComposeLog(final.log);
      if (!final || !final.ok) {
        setComposeStatus("failed");
        setWizardError("Docker Compose failed. Review the command output and retry.");
        return;
      }
      setComposeStatus("success");
      await loadRepoMetadata(createdProject.id);
      setWizardStep(5);
    } catch (err) {
      setComposeStatus("failed");
      setWizardError(err instanceof ApiError ? err.message : "Docker compose build failed");
    }
  }

  function resetEnvForm() {
    setEnvEditingId(null);
    setEnvPath("");
    setEnvVariables([{ ...EMPTY_VARIABLE }]);
    setEnvError("");
    closeImportPanel();
  }

  function newEnvFile() {
    setEnvEditingId(null);
    setEnvPath("front/.env");
    setEnvVariables([{ ...EMPTY_VARIABLE }]);
    setEnvError("");
    closeImportPanel();
  }

  function editEnvFile(envFile: ProjectEnvFile) {
    setEnvEditingId(envFile.id);
    setEnvPath(envFile.relativePath);
    setEnvVariables(envFile.variables.length > 0 ? envFile.variables : [{ ...EMPTY_VARIABLE }]);
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
    if (!createdProject) return;
    const variables = envVariables
      .map((item) => ({ key: item.key.trim(), value: item.value }))
      .filter((item) => item.key || item.value);

    setSavingEnv(true);
    setEnvError("");
    const toastId = notify.loading(envEditingId ? "Saving env file..." : "Creating env file...");
    try {
      const payload = { relativePath: envPath, variables };
      const saved = envEditingId
        ? await api.updateProjectEnvFile(createdProject.id, envEditingId, payload)
        : await api.createProjectEnvFile(createdProject.id, payload);
      setEnvFiles((items) => {
        if (!envEditingId) return [...items, saved].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
        return items.map((item) => item.id === saved.id ? saved : item).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
      });
      setEnvEditingId(saved.id);
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
    const ok = await confirm({
      title: `Delete ${envFile.relativePath}?`,
      description: "This removes the saved .env configuration from this project.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    if (!createdProject) return;
    const toastId = notify.loading(`Deleting ${envFile.relativePath}...`);
    try {
      await api.deleteProjectEnvFile(createdProject.id, envFile.id);
      setEnvFiles((items) => items.filter((item) => item.id !== envFile.id));
      if (envEditingId === envFile.id) resetEnvForm();
      notify.success(`${envFile.relativePath} deleted.`, { id: toastId });
    } catch (err) {
      notify.error(err, "Failed to delete env file", { id: toastId });
    }
  }

  async function applyProjectConfig(e: React.FormEvent) {
    e.preventDefault();
    if (!createdProject) return;
    setWizardError("");
    setConfigStatus("running");
    setNginxLog("Applying project routing...\n");
    const toastId = notify.loading("Applying project routing...");
    try {
      const updated = await api.updateProject(createdProject.id, {
        autoDeployBranch: wizardAutoDeployBranch || null,
      });
      setCreatedProject(updated);
      if (wizardSource === "github" && wizardComposeFileChoice) {
        await api.setProjectComposeFile(updated.id, wizardComposeFileChoice).catch(() => undefined);
      }

      let domainId: number | null = null;
      if (wizardDomain && wizardDomainService && wizardDomainPort) {
        const domain = await api.addProjectDomain(updated.id, wizardDomain, wizardDomainService, Number(wizardDomainPort));
        domainId = domain.id;
      }

      if (wizardUseSsl && domainId != null) {
        setNginxLog((value) => `${value}Issuing SSL certificate and rebuilding nginx...\n`);
        const final = await issueProjectDomainSsl(updated.id, domainId);
        setNginxLog((value) => `${value}${final?.log ?? ""}\n`);
        if (!final || !final.ok) {
          setConfigStatus("failed");
          setWizardError("SSL issuance or nginx rebuild failed. Review the command output and retry.");
          notify.error(new Error(final?.log || "SSL issuance failed"), "Failed to configure SSL", { id: toastId });
          return;
        }
      } else {
        setNginxLog((value) => `${value}Nginx rebuild queued.\n`);
      }
      setConfigStatus("success");
      setWizardStep(6);
      notify.success("Project is configured.", { id: toastId });
      refresh();
    } catch (err) {
      setConfigStatus("failed");
      setWizardError(err instanceof ApiError ? err.message : "Failed to configure project");
      notify.error(err, "Failed to configure project", { id: toastId });
    }
  }

  function closeAndReset() {
    setModalOpen(false);
    resetWizard();
  }

  function addAnotherProject() {
    resetWizard();
  }

  function goToCreatedProject() {
    if (!createdProject) return;
    const id = createdProject.id;
    setModalOpen(false);
    resetWizard();
    navigate(`/projects/${id}`);
  }

  useEffect(() => {
    if (!createdProject) return;
    const handler = (event: ProjectDeployEvent) => {
      if (event.projectId !== createdProject.id) return;
      if (event.action === "pull") {
        setPullLog((value) => `${value}${event.message}`.slice(-120_000));
      }
      if (event.action === "compose" || event.action === "build") {
        setComposeLog((value) => `${value}${event.message}`.slice(-120_000));
      }
      if (event.action === "upload") {
        setUploadLog((value) => `${value}${event.message}`.slice(-120_000));
      }
    };
    subscribeDeploy<ProjectDeployEvent>(createdProject.id, handler);
    return () => unsubscribeDeploy<ProjectDeployEvent>(createdProject.id, handler);
  }, [createdProject?.id, subscribeDeploy, unsubscribeDeploy]);

  const busy = creatingProject || pullStatus === "running" || composeStatus === "running" || configStatus === "running" || uploadStatus === "running";

  return (
    <>
      <main className="main">
        <div className="page-title" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}><FolderDot size={20} />Projects</span>
          <button type="button" className="btn btn-primary btn-sm" onClick={openWizard}>
            <Plus size={14} />
            Add new project
          </button>
        </div>

        <TooltipProvider>
          <div className="card">
            <div className="card-title" style={{justifyContent: "space-between"}}>
              <span><FolderDot size={12} />Projects</span>
              <AppSelect value={groupFilter} onValueChange={setGroupFilter} size="sm"
                options={[{value: "", label: "All groups"}, {value: "ungrouped", label: "Ungrouped"}, ...groupNames.map(group => ({value: `group:${group}`, label: group}))]} />
            </div>
            {loading ? (
              <div className="empty">Loading...</div>
            ) : visibleProjects.length === 0 ? (
              <div className="empty">{projects.length ? "No projects in this group." : "No projects yet."}</div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Group</th>
                      <th>Repository</th>
                      <th>Domain</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleProjects.map((p) => {
                      const tokenLabel = githubTokenLabel(p, githubCredentials);
                      const dockerAvailable = system?.docker?.available ?? false;
                      const pDockerStack = system?.docker ? findProjectStack(p, system.docker.stacks) : null;
                      const pStatus = deriveProjectStatus(p, pDockerStack, dockerAvailable);
                      const pStatusReason = `${projectStatusLabel(pStatus)} — ${explainProjectStatus(p, pDockerStack, dockerAvailable, pStatus)}`;
                      return (
                        <tr key={p.id}>
                          <td>
                            <div className="url-row" style={{ gap: 4 }}>
                              <button
                                type="button"
                                className="btn-icon"
                                aria-label={p.favorite ? `Unfavorite ${p.name}` : `Favorite ${p.name}`}
                                disabled={togglingFavoriteId === p.id}
                                onClick={(e) => { e.preventDefault(); e.stopPropagation(); void toggleFavorite(p); }}
                              >
                                <Star
                                  size={14}
                                  fill={p.favorite ? "currentColor" : "none"}
                                  style={p.favorite ? { color: "var(--brand)" } : undefined}
                                />
                              </button>
                              <Link className="ext-link url-row" to={`/projects/${p.id}`}>
                                <StatusDot status={pStatus} reason={pStatusReason} />
                                <span>{p.name}</span>
                                {p.paused && <span className="badge">Paused</span>}
                              </Link>
                            </div>
                          </td>
                          <td>{p.groupName || "Ungrouped"}</td>
                          <td>
                            {p.githubRepo ? (
                              <div className="url-row">
                                <GitBranch size={12} />
                                <span className="mono" style={{ fontSize: "0.85em" }}>{p.githubRepo}</span>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <button type="button" className="btn-icon" aria-label={tokenLabel}>
                                      <KeyRound size={12} />
                                    </button>
                                  </TooltipTrigger>
                                  <TooltipContent side="top">{tokenLabel}</TooltipContent>
                                </Tooltip>
                              </div>
                            ) : p.sourceType === "upload" ? (
                              <div className="url-row">
                                <Upload size={12} />
                                <span className="muted-text">Uploaded</span>
                              </div>
                            ) : <span className="muted-text">Not set</span>}
                          </td>
                          <td>
                            {(p.domains?.length ?? 0) > 0 ? (
                              <span className="url-row">
                                <a
                                  className="ext-link mono"
                                  href={`${p.domains![0].useSsl ? "https" : "http"}://${p.domains![0].domain}`}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {p.domains![0].domain}
                                </a>
                                {p.domains!.length > 1 && (
                                  <span className="muted-text" style={{ fontSize: "0.85em" }}>+{p.domains!.length - 1} more</span>
                                )}
                              </span>
                            ) : <span className="muted-text">Not set</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </TooltipProvider>
      </main>

      {modalOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={closeWizard}>
          <div className="modal-panel project-wizard-modal" role="dialog" aria-modal="true" aria-label="Add new project" onMouseDown={(event) => event.stopPropagation()}>
            <div className="wizard-header">
              <div>
                <div className="card-title" style={{ marginBottom: 4 }}><Plus size={12} />Add new project</div>
                <div className="muted-text">Create, pull, build, route, and publish a Docker Compose project.</div>
              </div>
              <button type="button" className="btn-icon" onClick={closeWizard} disabled={busy} aria-label="Close">
                <X size={16} />
              </button>
            </div>

            <WizardTimeline currentStep={wizardStep} statusByStep={statusByStep} steps={wizardSteps} />
            {wizardError && <div className="alert alert-error">{wizardError}</div>}

            {wizardStep === 1 && (
              <WizardScreen title="Repository information" description="Name the project, then either pull it from GitHub or upload a docker-compose.yml directly." icon={<GitBranch size={16} />}>
                <form onSubmit={(event) => void createProjectAndStartPull(event)} className="wizard-form">
                  <div className="field field-wide">
                    <label>Source</label>
                    <div style={{ display: "flex", gap: 8 }} role="group" aria-label="Project source">
                      <button
                        type="button"
                        className={`btn btn-sm${wizardSource === "github" ? " btn-primary" : " btn-ghost"}`}
                        onClick={() => setWizardSource("github")}
                        disabled={creatingProject}
                      >
                        <GitBranch size={13} />
                        From GitHub
                      </button>
                      <button
                        type="button"
                        className={`btn btn-sm${wizardSource === "upload" ? " btn-primary" : " btn-ghost"}`}
                        onClick={() => setWizardSource("upload")}
                        disabled={creatingProject}
                      >
                        <Upload size={13} />
                        Upload files
                      </button>
                    </div>
                  </div>
                  <div className="field">
                    <label>Name</label>
                    <input type="text" placeholder="My API" value={wizardName} onChange={(e) => setWizardName(e.target.value)} required />
                  </div>
                  <ProjectGroupField value={wizardGroupName} onValueChange={setWizardGroupName} projects={projects} disabled={creatingProject} />
                  {wizardSource === "github" ? (
                    <>
                      <div className="field">
                        <label>GitHub repo <span className="hint mono">(owner/repo or github link)</span></label>
                        <input type="text" placeholder="owner/repo or https://github.com/owner/repo" value={wizardRepo} onChange={(e) => setWizardRepo(e.target.value)} required />
                      </div>
                      <div className="field">
                        <label>GitHub token <span className="hint mono">(optional)</span></label>
                        <GitHubTokenSelect
                          credentials={credentials}
                          value={wizardGithubCredentialId}
                          onValueChange={setWizardGithubCredentialId}
                          disabled={creatingProject}
                          resetSignal={modalRunIdRef.current}
                        />
                      </div>
                    </>
                  ) : (
                    <div className="muted-text" style={{ marginBottom: 4 }}>
                      Next, you'll upload a docker-compose.yml (and any small support files it needs) directly — no repository required.
                    </div>
                  )}
                  <div className="wizard-actions">
                    <button type="button" className="btn btn-ghost" onClick={closeWizard} disabled={creatingProject}>Cancel</button>
                    <button type="submit" className="btn btn-primary" disabled={creatingProject}>
                      {creatingProject ? <Loader size={14} className="spin" /> : <ArrowRight size={14} />}
                      Create project
                    </button>
                  </div>
                </form>
              </WizardScreen>
            )}

            {wizardStep === 2 && wizardSource === "github" && (
              <WizardScreen title="Pull repository" description="Choose the branch to pull from GitHub. You'll build and start the stack after configuring env files." icon={<TerminalSquare size={16} />}>
                <div className="field field-wide">
                  <label><GitBranch size={12} />Branch to pull</label>
                  <ActionSelect
                    value={pullBranch}
                    onValueChange={setPullBranch}
                    disabled={pullStatus === "running" || pullStatus === "success"}
                    options={[
                      { value: "", label: "Repository default" },
                      ...branches.map((branch) => ({ value: branch.name, label: branch.name })),
                    ]}
                    action={(
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => createdProject && void loadWizardBranches(createdProject.id)}
                        disabled={!createdProject || loadingBranches || pullStatus === "running"}
                        title="Refresh branches"
                      >
                        {loadingBranches ? <Loader size={13} className="spin" /> : <RefreshCw size={13} />}
                      </button>
                    )}
                  />
                </div>

                <div className={`wizard-stage-card${pullStatus === "failed" ? " wizard-stage-card-failed" : pullStatus === "success" ? " wizard-stage-card-done" : ""}`}>
                  <div className="card-title"><GitBranch size={12} />Pull from GitHub</div>
                  <div className="muted-text">{pullStatus === "running" ? "Pulling repository..." : pullStatus === "success" ? "Repository is ready." : pullStatus === "failed" ? "Pull failed. Review output and retry." : "Waiting to start."}</div>
                </div>

                <pre className={`output-block wizard-output${pullStatus === "failed" ? " output-stderr" : ""}`}>
                  {pullLog || "Waiting for output..."}
                </pre>

                <div className="wizard-actions">
                  <button type="button" className="btn btn-ghost" onClick={closeWizard} disabled={busy}>Cancel</button>
                  {pullStatus === "idle" && (
                    <button type="button" className="btn btn-primary" onClick={() => createdProject && void runPull(createdProject)} disabled={busy || !createdProject}>
                      <GitBranch size={14} />
                      Pull repository
                    </button>
                  )}
                  {pullStatus === "failed" && (
                    <button type="button" className="btn btn-primary" onClick={() => void retryPull()} disabled={busy}>
                      <RefreshCw size={14} />
                      Retry pull
                    </button>
                  )}
                  {pullStatus === "success" && (
                    <button type="button" className="btn btn-primary" onClick={() => setWizardStep(3)}>
                      <ArrowRight size={14} />
                      Continue
                    </button>
                  )}
                </div>
              </WizardScreen>
            )}

            {wizardStep === 2 && wizardSource === "upload" && (
              <WizardScreen title="Upload files" description="Upload a docker-compose.yml and any support files it needs, then StackPort will validate and start it." icon={<Upload size={16} />}>
                <div className="field field-wide">
                  <label><FileText size={12} />docker-compose.yml</label>
                  <input
                    type="file"
                    accept=".yml,.yaml"
                    disabled={uploadStatus === "running" || uploadStatus === "success"}
                    onChange={(e) => setWizardComposeFile(e.target.files?.[0] ?? null)}
                  />
                  {wizardComposeFile && <div className="muted-text">{wizardComposeFile.name} ({Math.ceil(wizardComposeFile.size / 1024)} KB)</div>}
                </div>

                <div className="field field-wide">
                  <label>Support files <span className="hint mono">(optional — configs, Dockerfiles, etc.)</span></label>
                  {wizardSupportFiles.map((supportFile, index) => (
                    <div key={index} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                      <input
                        type="file"
                        disabled={uploadStatus === "running" || uploadStatus === "success"}
                        onChange={(e) => updateSupportFile(index, { file: e.target.files?.[0] ?? null })}
                      />
                      <input
                        type="text"
                        placeholder="relative path, e.g. nginx/nginx.conf"
                        value={supportFile.path}
                        disabled={uploadStatus === "running" || uploadStatus === "success"}
                        onChange={(e) => updateSupportFile(index, { path: e.target.value })}
                      />
                      <button
                        type="button"
                        className="btn-icon"
                        onClick={() => removeSupportFile(index)}
                        disabled={uploadStatus === "running" || uploadStatus === "success"}
                        aria-label="Remove file"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={addSupportFile}
                    disabled={uploadStatus === "running" || uploadStatus === "success"}
                  >
                    <Plus size={13} />
                    Add support file
                  </button>
                </div>

                <div className="wizard-stage-grid">
                  <div className={`wizard-stage-card${uploadStatus === "failed" ? " wizard-stage-card-failed" : uploadStatus === "success" ? " wizard-stage-card-done" : ""}`}>
                    <div className="card-title"><Upload size={12} />Upload &amp; validate</div>
                    <div className="muted-text">{uploadStatus === "running" ? "Staging and validating files..." : uploadStatus === "success" ? "Files applied." : uploadStatus === "failed" ? "Upload failed. Review output and retry." : "Waiting to start."}</div>
                  </div>
                  <div className={`wizard-stage-card${composeStatus === "failed" ? " wizard-stage-card-failed" : composeStatus === "success" ? " wizard-stage-card-done" : ""}`}>
                    <div className="card-title"><Server size={12} />Docker compose</div>
                    <div className="muted-text">{composeStatus === "running" ? "Building and starting stack..." : composeStatus === "success" ? "Compose completed." : composeStatus === "failed" ? "Compose failed. Retry after reviewing output." : "Runs right after upload."}</div>
                  </div>
                </div>

                <pre className={`output-block wizard-output${uploadStatus === "failed" ? " output-stderr" : ""}`}>
                  {[uploadLog, composeLog].filter(Boolean).join("\n") || "Waiting for output..."}
                </pre>

                <div className="wizard-actions">
                  <button type="button" className="btn btn-ghost" onClick={closeWizard} disabled={busy}>Cancel</button>
                  {uploadStatus === "idle" && (
                    <button type="button" className="btn btn-primary" onClick={() => createdProject && void runUpload(createdProject)} disabled={busy || !createdProject || !wizardComposeFile}>
                      <Upload size={14} />
                      Upload &amp; start
                    </button>
                  )}
                  {uploadStatus === "failed" && (
                    <button type="button" className="btn btn-primary" onClick={() => createdProject && void runUpload(createdProject)} disabled={busy || !createdProject}>
                      <RefreshCw size={14} />
                      Retry upload
                    </button>
                  )}
                  {uploadStatus === "success" && (
                    <button type="button" className="btn btn-primary" onClick={() => setWizardStep(3)}>
                      <ArrowRight size={14} />
                      Continue
                    </button>
                  )}
                </div>
              </WizardScreen>
            )}

            {wizardStep === 3 && (
              <WizardScreen title="Environment files" description="Add any .env files the project needs before configuring routing. You can also do this later from the project page." icon={<FileText size={16} />}>
                {envError && <div className="alert alert-error">{envError}</div>}

                <div className={envStyles.envWorkspace}>
                  <aside className={envStyles.envFileRail}>
                    <div className={envStyles.envRailHeader}>
                      <span>Configured</span>
                      <span>{envFiles.reduce((total, file) => total + file.variables.length, 0)} vars</span>
                    </div>
                    {envFiles.length === 0 ? (
                      <div className={envStyles.envRailEmpty}>No files yet.</div>
                    ) : envFiles.map((envFile) => (
                      <button
                        type="button"
                        className={cn(envStyles.envFileButton, envEditingId === envFile.id && envStyles.envFileButtonActive)}
                        key={envFile.id}
                        onClick={() => editEnvFile(envFile)}
                      >
                        <span className={envStyles.envFileName}>
                          <FileText size={13} />
                          <span>{envFile.relativePath}</span>
                        </span>
                        <span className={envStyles.envFileMeta}>{envFile.variables.length} variables</span>
                      </button>
                    ))}
                  </aside>

                  <form onSubmit={(e) => void saveEnvFile(e)} className={envStyles.envEditorPanel}>
                    <div className={envStyles.envEditorTopbar}>
                      <div>
                        <div className={envStyles.envEditorTitle}>{selectedEnvFile ? selectedEnvFile.relativePath : "New env file"}</div>
                        <div className="muted-text">{filledEnvVariables.length} populated variables</div>
                      </div>
                      <div className="row-actions">
                        {selectedEnvFile && (
                          <Button
                            type="button"
                            variant="outline"
                            size="xs"
                            className={envStyles.envDeleteButton}
                            onClick={() => void deleteEnvFile(selectedEnvFile)}
                          >
                            <Trash2 size={12} />
                            Delete
                          </Button>
                        )}
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

                    <div className={envStyles.envPathRow}>
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
                      <div className={envStyles.envImportPanel}>
                        {importError && <div className="alert alert-error">{importError}</div>}
                        <div className={envStyles.envImportGrid}>
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
                            className={envStyles.envDropZone}
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
                          className={envStyles.envImportTextarea}
                          placeholder={"API_URL=https://example.com\nNODE_ENV=production"}
                          value={importText}
                          onChange={(e) => setImportText(e.target.value)}
                        />
                        <div className={envStyles.envImportActions}>
                          <Button type="button" variant="ghost" size="xs" onClick={closeImportPanel}>
                            Cancel
                          </Button>
                          <Button type="button" size="xs" onClick={applyEnvImport} disabled={!importText.trim()}>
                            Parse
                          </Button>
                        </div>
                      </div>
                    )}

                    <div className={envStyles.envVarTable}>
                      <div className={envStyles.envVarHeader}>
                        <span>Key</span>
                        <span>Value</span>
                        <span />
                      </div>
                      {envVariables.map((variable, index) => (
                        <div className={envStyles.envVarRow} key={index}>
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

                    <div className={envStyles.envEditorActions}>
                      <Button type="button" variant="outline" size="xs" onClick={resetEnvForm} disabled={!envDraftChanged && !envEditingId}>
                        <X size={12} />
                        Clear
                      </Button>
                      <Button type="submit" size="xs" disabled={savingEnv || !envPath.trim()}>
                        {savingEnv ? <Loader size={12} className="spin" /> : <Save size={12} />}
                        {envEditingId ? "Save" : "Create"}
                      </Button>
                    </div>
                  </form>
                </div>

                <div className="wizard-actions">
                  <button type="button" className="btn btn-ghost" onClick={() => setWizardStep(2)}>Back</button>
                  <button type="button" className="btn btn-primary" onClick={() => setWizardStep(wizardSource === "upload" ? 5 : 4)}>
                    <ArrowRight size={14} />
                    Continue
                  </button>
                </div>
              </WizardScreen>
            )}

            {wizardStep === 4 && wizardSource === "github" && (
              <WizardScreen title="Build & start" description="Run Docker Compose to build images and start the stack, using the env files you just configured." icon={<Server size={16} />}>
                <div className={`wizard-stage-card${composeStatus === "failed" ? " wizard-stage-card-failed" : composeStatus === "success" ? " wizard-stage-card-done" : ""}`}>
                  <div className="card-title"><Server size={12} />Docker compose</div>
                  <div className="muted-text">{composeStatus === "running" ? "Building and starting stack..." : composeStatus === "success" ? "Compose completed." : composeStatus === "failed" ? "Compose failed. Retry after reviewing output." : "Ready to build and start the stack."}</div>
                </div>

                <pre className={`output-block wizard-output${composeStatus === "failed" ? " output-stderr" : ""}`}>
                  {composeLog || "Waiting for output..."}
                </pre>

                <div className="wizard-actions">
                  <button type="button" className="btn btn-ghost" onClick={() => setWizardStep(3)} disabled={busy}>Back</button>
                  {composeStatus !== "success" && (
                    <button type="button" className="btn btn-primary" onClick={() => void runComposeBuild()} disabled={composeStatus === "running"}>
                      {composeStatus === "running" ? <Loader size={14} className="spin" /> : <Server size={14} />}
                      {composeStatus === "failed" ? "Retry Docker Compose" : "Run Docker Compose"}
                    </button>
                  )}
                  {composeStatus === "success" && (
                    <button type="button" className="btn btn-primary" onClick={() => setWizardStep(5)}>
                      <ArrowRight size={14} />
                      Continue
                    </button>
                  )}
                </div>
              </WizardScreen>
            )}

            {wizardStep === 5 && (
              <WizardScreen title="Project configuration" description="Choose the domain, detected service and port, auto-deploy branch, and SSL behavior." icon={<Settings2 size={16} />}>
                <form onSubmit={(event) => void applyProjectConfig(event)} className="wizard-form">
                  {wizardSource === "github" && composeFiles.length > 0 && (
                    <div className="form-row">
                      <div className="field field-wide">
                        <label><FileText size={12} />Compose file</label>
                        <AppSelect
                          value={wizardComposeFileChoice}
                          onValueChange={setWizardComposeFileChoice}
                          options={composeFiles.map((file) => ({ value: file, label: file }))}
                        />
                      </div>
                    </div>
                  )}
                  <div className="form-row">
                    <div className="field field-wide">
                      <label><Globe size={12} />Domain</label>
                      <input type="text" placeholder="myapp.example.com" value={wizardDomain} onChange={(e) => setWizardDomain(e.target.value)} />
                    </div>
                    <div className="field field-wide">
                      <label>Service and container port</label>
                      {createdProject && <ProjectIngressSelect projectId={createdProject.id} composeFile={wizardComposeFileChoice || createdProject.composeFile}
                        value={wizardDomainService && wizardDomainPort ? `${wizardDomainService}:${wizardDomainPort}` : ""}
                        disabled={configStatus === "running"}
                        onValueChange={value => { const [service = "", port = ""] = value.split(":"); setWizardDomainService(service); setWizardDomainPort(port); }} />}
                    </div>
                  </div>

                  <div className="form-row">
                    <div className="field field-wide">
                      <label><GitBranch size={12} />Auto-deploy branch</label>
                      <ActionSelect
                        value={wizardAutoDeployBranch}
                        onValueChange={setWizardAutoDeployBranch}
                        options={[
                          { value: "", label: "Off" },
                          ...branches.map((branch) => ({ value: branch.name, label: branch.name })),
                        ]}
                        action={(
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => createdProject && void api.getProjectBranches(createdProject.id).then((data) => setBranches(data.branches)).catch((err) => setWizardError(err instanceof ApiError ? err.message : "Failed to refresh branches"))}
                            disabled={!createdProject || configStatus === "running"}
                            title="Refresh branches"
                          >
                            <RefreshCw size={13} />
                          </button>
                        )}
                      />
                    </div>
                    <label className="wizard-switch-row" style={{ opacity: wizardDomain && sslReady ? 1 : 0.55 }}>
                      <Switch checked={wizardUseSsl} onCheckedChange={(checked) => setWizardUseSsl(checked)} disabled={!wizardDomain || !sslReady || configStatus === "running"} />
                      <span>
                        <span><Lock size={12} />Use SSL</span>
                        <span>{!sslReady ? "Certbot email/tooling unavailable" : !wizardDomain ? "Set a domain to issue SSL" : "Issue certificate, then rebuild nginx"}</span>
                      </span>
                    </label>
                  </div>

                  {nginxLog && <pre className={`output-block wizard-output${configStatus === "failed" ? " output-stderr" : ""}`}>{nginxLog}</pre>}

                  <div className="wizard-actions">
                    <button type="button" className="btn btn-ghost" onClick={() => setWizardStep(wizardSource === "upload" ? 3 : 4)} disabled={configStatus === "running"}>Back</button>
                    <button type="submit" className="btn btn-primary" disabled={configStatus === "running" || !createdProject || (!!wizardDomain && (!wizardDomainService || !wizardDomainPort))}>
                      {configStatus === "running" ? <Loader size={14} className="spin" /> : <Lock size={14} />}
                      Next: Apply nginx
                    </button>
                  </div>
                </form>
              </WizardScreen>
            )}

            {wizardStep === 6 && createdProject && (
              <WizardScreen title="Project ready" description="The project was created and the deployment route has been configured." icon={<CheckCircle size={16} />}>
                <div className="wizard-finished-panel">
                  <span className="wizard-finished-icon"><CheckCircle size={22} /></span>
                  <div>
                    <strong>{createdProject.name}</strong>
                    <p>{wizardDomain ? `${wizardDomain}${wizardUseSsl ? " is configured with SSL." : " is configured."}` : "Project configuration was saved."}</p>
                  </div>
                </div>
                {nginxLog && <pre className="output-block wizard-output">{nginxLog}</pre>}
                <div className="wizard-actions">
                  <button type="button" className="btn btn-ghost" onClick={closeAndReset}>Close</button>
                  <button type="button" className="btn btn-secondary" onClick={addAnotherProject}>
                    <Plus size={14} />
                    Add another
                  </button>
                  <button type="button" className="btn btn-primary" onClick={goToCreatedProject}>
                    <FolderDot size={14} />
                    Open project
                  </button>
                </div>
              </WizardScreen>
            )}
          </div>
        </div>
      )}
    </>
  );
}
