import { useEffect, useReducer, useRef, type ComponentType, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle,
  Circle,
  FileText,
  FolderDot,
  GitBranch,
  Globe,
  Loader,
  Lock,
  Plus,
  RefreshCw,
  Rocket,
  Settings2,
  Upload,
  X,
  XCircle,
} from "lucide-react";
import { api, ApiError } from "../../api/client";
import type { ComposeEnvFileRef, Credential, DeployTrigger, GitHubBranch, Project, ProjectDeployEvent, ProjectEnvFile } from "../../api/types";
import { useSocket } from "../../context/SocketContext";
import { pollProjectAction, useSystem } from "../../context/SystemContext";
import { notify } from "../../lib/notify";
import { cn } from "../../lib/utils";
import { ActionSelect, AppSelect } from "../AppSelect";
import { useConfirm } from "../ConfirmDialog";
import { EnvManagerDialog } from "../EnvManagerDialog";
import { GitHubTokenSelect } from "../GitHubTokenSelect";
import { ProjectGroupField } from "../ProjectGroupField";
import { ProjectIngressSelect } from "../ProjectIngressSelect";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import styles from "./NewProjectWizard.module.scss";

type Stage = "source" | "configure" | "deploy";
type StageStatus = "idle" | "running" | "success" | "failed";
type Source = "github" | "upload";
type DeployStepId = "checkout" | "settings" | "compose" | "domain" | "ssl";

const STAGES: { id: Stage; label: string; icon: ComponentType<{ size?: number }> }[] = [
  { id: "source", label: "Source", icon: GitBranch },
  { id: "configure", label: "Configure", icon: Settings2 },
  { id: "deploy", label: "Deploy", icon: Rocket },
];

const TRIGGER_OPTIONS: { value: DeployTrigger; label: string; hint: string }[] = [
  { value: "poller", label: "Poller", hint: "StackPort checks the branch for new commits and deploys them." },
  { value: "webhook", label: "Webhook", hint: "GitHub notifies StackPort on every push." },
  { value: "manual", label: "Manual only", hint: "New commits wait until you press Redeploy." },
];

const LOG_LIMIT = 120_000;

const DEPLOY_STEP_CLASS: Record<StageStatus, string | undefined> = {
  idle: undefined,
  running: styles.deployStepRunning,
  success: styles.deployStepSuccess,
  failed: styles.deployStepFailed,
};

interface SupportFile {
  file: File | null;
  path: string;
}

interface WizardState {
  stage: Stage;
  source: Source;
  name: string;
  nameEdited: boolean;
  groupName: string;
  repo: string;
  credentialId: number | null;
  composeUpload: File | null;
  supportFiles: SupportFile[];
  project: Project | null;
  fetchStatus: StageStatus;
  fetchLog: string;
  branches: GitHubBranch[];
  loadingBranches: boolean;
  branchesError: string;
  branch: string;
  checkedOutBranch: string;
  trigger: DeployTrigger;
  webhookAvailable: boolean;
  composeFile: string;
  envFiles: ProjectEnvFile[];
  envRefs: ComposeEnvFileRef[];
  envEditorPath: string | null | undefined;
  domain: string;
  ingress: string;
  useSsl: boolean;
  sslReady: boolean;
  steps: Record<DeployStepId, StageStatus>;
  deployLog: string;
  finished: boolean;
  error: string;
}

const IDLE_STEPS: Record<DeployStepId, StageStatus> = { checkout: "idle", settings: "idle", compose: "idle", domain: "idle", ssl: "idle" };

const INITIAL: WizardState = {
  stage: "source",
  source: "github",
  name: "",
  nameEdited: false,
  groupName: "",
  repo: "",
  credentialId: null,
  composeUpload: null,
  supportFiles: [],
  project: null,
  fetchStatus: "idle",
  fetchLog: "",
  branches: [],
  loadingBranches: false,
  branchesError: "",
  branch: "",
  checkedOutBranch: "",
  trigger: "poller",
  webhookAvailable: false,
  composeFile: "",
  envFiles: [],
  envRefs: [],
  envEditorPath: null,
  domain: "",
  ingress: "",
  useSsl: false,
  sslReady: false,
  steps: IDLE_STEPS,
  deployLog: "",
  finished: false,
  error: "",
};

type Patch = Partial<WizardState> | ((state: WizardState) => Partial<WizardState>);

function reducer(state: WizardState, patch: Patch): WizardState {
  return { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
}

/** "owner/repo", "https://github.com/owner/repo(.git)" → "repo". */
function nameFromRepo(repo: string): string {
  const match = repo.trim().replace(/\.git$/, "").match(/([^/\s]+)\/?$/);
  return match ? match[1] : "";
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : err instanceof Error ? err.message : fallback;
}

function StatusIcon({ status, size = 14 }: { status: StageStatus; size?: number }) {
  if (status === "running") return <Loader size={size} className="spin" />;
  if (status === "success") return <CheckCircle size={size} />;
  if (status === "failed") return <XCircle size={size} />;
  return <Circle size={size} />;
}

function WizardTimeline({ stage, statusByStage }: { stage: Stage; statusByStage: Record<Stage, StageStatus> }) {
  return (
    <TooltipProvider>
      <div className="wizard-timeline" aria-label="Project creation progress">
        {STAGES.map((item, index) => {
          const status = statusByStage[item.id];
          const active = item.id === stage;
          const done = status === "success";
          const Icon = item.icon;
          return (
            <div key={item.id} className="wizard-timeline-item-wrap">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className={cn("wizard-timeline-item", active && "wizard-timeline-active", done && "wizard-timeline-done", status === "failed" && "wizard-timeline-failed")}
                    aria-current={active ? "step" : undefined}
                    tabIndex={0}
                  >
                    {done ? <CheckCircle size={13} /> : <Icon size={13} />}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">{item.label}</TooltipContent>
              </Tooltip>
              <span className={cn("wizard-timeline-label", !active && styles.timelineLabelIdle)}>{item.label}</span>
              {index < STAGES.length - 1 && <span className={cn("wizard-timeline-line", done && "wizard-timeline-line-done")} />}
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

function Section({ title, icon, aside, children }: { title: string; icon: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className={styles.section}>
      <header className={styles.sectionHeader}>
        <span className={styles.sectionTitle}>{icon}{title}</span>
        {aside}
      </header>
      {children}
    </section>
  );
}

interface NewProjectWizardProps {
  projects: Project[];
  credentials: Credential[];
  /** An existing project whose setup was left unfinished; the wizard picks it up where it stopped. */
  resumeProject?: Project | null;
  onClose: () => void;
}

/**
 * Three stages: Source creates the project and fetches its files without starting
 * anything; Configure gathers every setting (compose file, branch, env files,
 * routing); Deploy applies them and starts the stack once, in that order.
 */
export function NewProjectWizard({ projects, credentials, resumeProject, onClose }: NewProjectWizardProps) {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { subscribeDeploy, unsubscribeDeploy } = useSocket();
  const { refreshProjects, startProjectAction, issueProjectDomainSsl } = useSystem();
  const [state, set] = useReducer(reducer, INITIAL);
  const runIdRef = useRef(0);
  const logTargetRef = useRef<"fetch" | "deploy">("fetch");
  // A ref, not state: the SSL step reads it in the same run that the domain step set it.
  const routedDomainRef = useRef<{ id: number; key: string } | null>(null);
  const { project, source } = state;

  const busy = state.fetchStatus === "running" || state.loadingBranches || Object.values(state.steps).includes("running");
  const isGithub = source === "github";

  useEffect(() => {
    if (!resumeProject) return;
    const resumedSource: Source = resumeProject.sourceType === "upload" ? "upload" : "github";
    set({
      project: resumeProject,
      source: resumedSource,
      name: resumeProject.name,
      nameEdited: true,
      groupName: resumeProject.groupName ?? "",
      repo: resumeProject.githubRepo ?? "",
      credentialId: resumeProject.githubCredentialId,
    });
    if (resumeProject.composeFile) void enterConfigure(resumeProject.id, resumedSource);
    // Runs once for the project the wizard was opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeProject?.id]);

  // Live output for whichever stage is running; the final action record replaces it when it ends.
  useEffect(() => {
    if (!project) return;
    const handler = (event: ProjectDeployEvent) => {
      if (event.projectId !== project.id) return;
      if (logTargetRef.current === "fetch" && (event.action === "pull" || event.action === "upload")) {
        set((s) => ({ fetchLog: `${s.fetchLog}${event.message}`.slice(-LOG_LIMIT) }));
      } else if (logTargetRef.current === "deploy" && (event.action === "pull" || event.action === "compose" || event.action === "build")) {
        set((s) => ({ deployLog: `${s.deployLog}${event.message}`.slice(-LOG_LIMIT) }));
      }
    };
    subscribeDeploy<ProjectDeployEvent>(project.id, handler);
    return () => unsubscribeDeploy<ProjectDeployEvent>(project.id, handler);
  }, [project?.id, subscribeDeploy, unsubscribeDeploy]);

  // ── Source ────────────────────────────────────────────────────────────────

  async function submitSource(event: React.FormEvent) {
    event.preventDefault();
    if (source === "upload" && !state.composeUpload) {
      set({ error: "Choose a docker-compose.yml file first." });
      return;
    }
    const runId = ++runIdRef.current;
    set({ error: "", fetchStatus: "running", fetchLog: "" });
    let target = project;
    try {
      if (!target) {
        target = await api.createProject(source === "upload"
          ? { name: state.name.trim(), groupName: state.groupName.trim() || null, sourceType: "upload" }
          : { name: state.name.trim(), groupName: state.groupName.trim() || null, githubRepo: state.repo.trim(), githubCredentialId: state.credentialId ?? undefined });
        refreshProjects();
      } else if (isGithub && (target.githubRepo !== state.repo.trim() || target.githubCredentialId !== state.credentialId)) {
        // A failed clone is usually a typo in the repo or the wrong token: let a retry fix both.
        target = await api.updateProject(target.id, { githubRepo: state.repo.trim(), githubCredentialId: state.credentialId });
      }
      if (runIdRef.current !== runId) return;
      set({ project: target });
    } catch (err) {
      if (runIdRef.current !== runId) return;
      set({ fetchStatus: "failed", error: errorMessage(err, "Failed to create project") });
      return;
    }

    logTargetRef.current = "fetch";
    const ok = isGithub ? await fetchFromGithub(target, runId) : await stageUpload(target, runId);
    if (runIdRef.current !== runId) return;
    if (!ok) return;
    set({ fetchStatus: "success" });
    await enterConfigure(target.id, source);
  }

  async function fetchFromGithub(target: Project, runId: number): Promise<boolean> {
    set({ fetchLog: "Cloning repository...\n" });
    const final = await startProjectAction(target.id, "pull");
    if (runIdRef.current !== runId) return false;
    if (final?.log) set({ fetchLog: final.log });
    if (!final?.ok) {
      set({ fetchStatus: "failed", error: "Couldn't fetch the repository. Check the repo name and token, then retry." });
      return false;
    }
    return true;
  }

  async function stageUpload(target: Project, runId: number): Promise<boolean> {
    set({ fetchLog: "Uploading files...\n" });
    try {
      const supportFiles = state.supportFiles
        .filter((f): f is { file: File; path: string } => f.file !== null && f.path.trim().length > 0)
        .map((f) => ({ file: f.file, path: f.path.trim() }));
      const started = await api.uploadProjectCompose(target.id, state.composeUpload!, supportFiles, { deploy: false });
      if (!started.started) {
        set({ fetchStatus: "failed", error: started.error ?? "An action is already running for this project" });
        return false;
      }
      const final = await pollProjectAction(target.id, "repo");
      if (runIdRef.current !== runId) return false;
      if (final?.log) set({ fetchLog: final.log });
      if (!final?.ok) {
        set({ fetchStatus: "failed", error: "The files didn't pass validation. Fix them and retry." });
        return false;
      }
      return true;
    } catch (err) {
      if (runIdRef.current !== runId) return false;
      set({ fetchStatus: "failed", error: errorMessage(err, "Upload failed") });
      return false;
    }
  }

  // ── Configure ─────────────────────────────────────────────────────────────

  async function enterConfigure(projectId: number, projectSource: Source) {
    const [fresh, envFiles, branchData, system, webhook] = await Promise.all([
      api.getProject(projectId),
      api.listProjectEnvFiles(projectId).catch(() => [] as ProjectEnvFile[]),
      projectSource === "github"
        ? api.getProjectBranches(projectId).catch((err: unknown) => ({ branches: [] as GitHubBranch[], autoDeployBranch: null, error: errorMessage(err, "Couldn't list branches") }))
        : Promise.resolve({ branches: [] as GitHubBranch[], autoDeployBranch: null }),
      api.getSystem().catch(() => null),
      projectSource === "github" ? api.getProjectWebhook(projectId).catch(() => null) : Promise.resolve(null),
    ]).catch((err: unknown) => {
      set({ error: errorMessage(err, "Failed to load the project") });
      return [null, [], { branches: [], autoDeployBranch: null }, null, null] as const;
    });
    if (!fresh) return;
    // Without a branch list (rate limit, token scope) fall back to a typed name; "main" is the common default.
    const branch = fresh.autoDeployBranch ?? branchData.autoDeployBranch ?? (projectSource === "github" ? "main" : "");
    set({
      stage: "configure",
      project: fresh,
      envFiles,
      branches: branchData.branches,
      branchesError: "error" in branchData ? branchData.error : "",
      branch,
      checkedOutBranch: "",
      trigger: fresh.deployTrigger,
      webhookAvailable: !!webhook?.available,
      composeFile: fresh.composeFile ?? fresh.availableComposeFiles[0] ?? "",
      sslReady: !!(system?.certbot?.available && system.certbot.emailConfigured),
    });
    void loadEnvRefs(projectId, fresh.composeFile ?? undefined);
  }

  async function loadEnvRefs(projectId: number, composeFile?: string) {
    const refs = await api.getProjectComposeEnvFiles(projectId, composeFile).catch(() => [] as ComposeEnvFileRef[]);
    set({ envRefs: refs });
  }

  async function refreshBranches() {
    if (!project) return;
    set({ loadingBranches: true });
    try {
      const data = await api.getProjectBranches(project.id, true);
      set({ branches: data.branches, branchesError: "" });
    } catch (err) {
      set({ error: errorMessage(err, "Failed to load branches") });
    } finally {
      set({ loadingBranches: false });
    }
  }

  /** Switching branch checks it out right away so the compose files, services and env hints match it. */
  async function changeBranch(branch: string) {
    if (!project || branch === state.branch) return;
    const previous = state.branch;
    set({ branch, loadingBranches: true, error: "" });
    logTargetRef.current = "fetch";
    const final = await startProjectAction(project.id, "pull", { branch });
    if (!final?.ok) {
      set({ branch: previous, loadingBranches: false, error: `Couldn't check out ${branch}.` });
      return;
    }
    const fresh = await api.getProject(project.id).catch(() => project);
    const composeFile = fresh.availableComposeFiles.includes(state.composeFile) ? state.composeFile : fresh.composeFile ?? fresh.availableComposeFiles[0] ?? "";
    set({ project: fresh, composeFile, checkedOutBranch: branch, loadingBranches: false });
    void loadEnvRefs(fresh.id, composeFile || undefined);
  }

  function changeComposeFile(composeFile: string) {
    set({ composeFile });
    if (project) void loadEnvRefs(project.id, composeFile);
  }

  const managedEnvPaths = new Set(state.envFiles.map((file) => file.relativePath));
  const missingEnvRefs = state.envRefs.filter((ref) => !ref.existsInSource && !managedEnvPaths.has(ref.path));
  const blockingEnvRefs = missingEnvRefs.filter((ref) => ref.required);
  const [ingressService = "", ingressPort = ""] = state.ingress.split(":");
  const routingIncomplete = !!state.domain.trim() && !state.ingress;

  // ── Deploy ────────────────────────────────────────────────────────────────

  const domain = state.domain.trim();
  const deploySteps: { id: DeployStepId; label: string }[] = [
    ...(isGithub ? [{ id: "checkout" as const, label: state.branch ? `Check out ${state.branch}` : "Check out the repository" }] : []),
    { id: "settings", label: "Save settings" },
    { id: "compose", label: "Build and start the stack" },
    ...(domain ? [{ id: "domain" as const, label: `Route ${domain} → ${ingressService}:${ingressPort}` }] : []),
    ...(domain && state.useSsl ? [{ id: "ssl" as const, label: "Issue SSL certificate" }] : []),
  ];

  function startDeploy() {
    set({ stage: "deploy", steps: IDLE_STEPS, deployLog: "", error: "", finished: false });
    void runDeploy(deploySteps[0].id);
  }

  async function runDeploy(from: DeployStepId) {
    if (!project) return;
    const runId = ++runIdRef.current;
    const order = deploySteps.map((step) => step.id);
    let current = project;
    logTargetRef.current = "deploy";
    for (const id of order.slice(order.indexOf(from))) {
      if (runIdRef.current !== runId) return;
      set((s) => ({ steps: { ...s.steps, [id]: "running" }, error: "" }));
      try {
        const result = await runDeployStep(id, current);
        if (result.project) current = result.project;
        if (result.log) set((s) => ({ deployLog: `${s.deployLog}${result.log}\n`.slice(-LOG_LIMIT) }));
        if (!result.ok) {
          set((s) => ({ steps: { ...s.steps, [id]: "failed" }, error: result.error ?? "This step failed. Review the output and retry." }));
          return;
        }
      } catch (err) {
        set((s) => ({ steps: { ...s.steps, [id]: "failed" }, error: errorMessage(err, "This step failed") }));
        return;
      }
      set((s) => ({ steps: { ...s.steps, [id]: "success" } }));
    }
    set({ project: current, finished: true });
    refreshProjects();
    notify.success(`${current.name} is deployed.`);
  }

  async function runDeployStep(id: DeployStepId, current: Project): Promise<{ ok: boolean; project?: Project; log?: string; error?: string }> {
    switch (id) {
      case "checkout": {
        set((s) => ({ deployLog: `${s.deployLog}$ checkout ${state.branch || "default branch"}\n` }));
        const final = await startProjectAction(current.id, "pull", state.branch ? { branch: state.branch } : undefined);
        return final?.ok ? { ok: true } : { ok: false, error: "Checking out the branch failed. Review the output and retry." };
      }
      case "settings": {
        let updated = current;
        if (isGithub) updated = await api.updateProject(current.id, { autoDeployBranch: state.branch || null });
        if (state.composeFile && state.composeFile !== updated.composeFile) updated = await api.setProjectComposeFile(current.id, state.composeFile);
        let warning = "";
        if (isGithub && state.trigger !== updated.deployTrigger) {
          const result = await api.setDeployTrigger(current.id, state.trigger);
          updated = result.project;
          warning = result.installError ? `Webhook saved, but StackPort couldn't install it on GitHub: ${result.installError}` : result.warning ?? "";
        }
        if (warning) notify.error(new Error(warning), "Deploy trigger needs attention");
        set({ project: updated });
        return { ok: true, project: updated, log: "Settings saved." };
      }
      case "compose": {
        const final = await startProjectAction(current.id, "compose");
        return final?.ok ? { ok: true } : { ok: false, error: "Docker Compose failed. Fix the env files or compose file in Configure, then deploy again." };
      }
      case "domain": {
        const key = `${domain}|${state.ingress}`;
        if (routedDomainRef.current?.key === key) return { ok: true, log: `${domain} is already routed.` };
        // Retrying after the domain or route changed in Configure: replace the one this wizard added.
        if (routedDomainRef.current) await api.removeProjectDomain(current.id, routedDomainRef.current.id).catch(() => undefined);
        const added = await api.addProjectDomain(current.id, domain, ingressService, Number(ingressPort));
        routedDomainRef.current = { id: added.id, key };
        return { ok: true, log: `Routed ${domain} to ${ingressService}:${ingressPort}. Nginx rebuild queued.` };
      }
      case "ssl": {
        const domainId = routedDomainRef.current?.id;
        if (domainId == null) return { ok: false, error: "The domain wasn't added, so there's nothing to certify." };
        const final = await issueProjectDomainSsl(current.id, domainId);
        return final?.ok
          ? { ok: true, log: final.log }
          : { ok: false, log: final?.log, error: "SSL issuance failed. Check that the domain points at this server, then retry." };
      }
    }
  }

  const failedStep = deploySteps.find((step) => state.steps[step.id] === "failed");

  // ── Closing ───────────────────────────────────────────────────────────────

  async function requestClose() {
    if (busy) return;
    if (project && !state.finished && !resumeProject) {
      const containersMayRun = state.steps.compose !== "idle";
      const discard = await confirm({
        title: `Discard ${project.name}?`,
        description: containersMayRun
          ? "Setup isn't finished. Discard stops its containers and removes the project. Keep leaves it so you can finish setup later."
          : "Setup isn't finished. Discard removes the project. Keep leaves it in your list with a Finish setup button.",
        confirmLabel: "Discard project",
        cancelLabel: "Keep it",
        destructive: true,
      });
      onClose();
      if (discard) await discardProject(project, containersMayRun);
      else notify.success(`${project.name} kept. Finish setting it up from the projects list.`);
      refreshProjects();
      return;
    }
    onClose();
  }

  async function discardProject(target: Project, stopFirst: boolean) {
    if (stopFirst) {
      const stopped = await startProjectAction(target.id, "stop");
      if (!stopped?.ok) {
        notify.error(new Error("Its containers didn't stop, so the project was kept. Stop and delete it from its page."), `Couldn't discard ${target.name}`);
        return;
      }
    }
    try {
      await api.deleteProject(target.id);
      notify.success(`${target.name} discarded.`);
    } catch (err) {
      notify.error(err, `Couldn't discard ${target.name}`);
    }
  }

  function addAnother() {
    runIdRef.current += 1;
    routedDomainRef.current = null;
    set(INITIAL);
  }

  function openProject() {
    if (!project) return;
    onClose();
    navigate(`/projects/${project.id}`);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const statusByStage: Record<Stage, StageStatus> = {
    source: state.stage !== "source" ? "success" : state.fetchStatus,
    configure: state.stage === "deploy" ? "success" : "idle",
    deploy: state.finished ? "success" : failedStep ? "failed" : state.stage === "deploy" ? "running" : "idle",
  };
  const sourceLocked = !!project || state.fetchStatus === "running";
  const sourceFilesLocked = state.fetchStatus === "running";

  return (
    <>
      <div className="modal-backdrop" role="presentation" onMouseDown={() => void requestClose()}>
        <div className="modal-panel project-wizard-modal" role="dialog" aria-modal="true" aria-label="Add new project" onMouseDown={(event) => event.stopPropagation()}>
          <div className="wizard-header">
            <div>
              <div className="card-title" style={{ marginBottom: 4 }}><Plus size={12} />{resumeProject ? `Finish setting up ${resumeProject.name}` : "Add new project"}</div>
              <div className="muted-text">Pick a source, configure it, then deploy once.</div>
            </div>
            <button type="button" className="btn-icon" onClick={() => void requestClose()} disabled={busy} aria-label="Close">
              <X size={16} />
            </button>
          </div>

          <WizardTimeline stage={state.stage} statusByStage={statusByStage} />
          {state.error && <div className="alert alert-error">{state.error}</div>}

          {state.stage === "source" && (
            <WizardScreen
              title="Where does it come from?"
              description="StackPort fetches the files and checks them. Nothing starts until you deploy."
              icon={isGithub ? <GitBranch size={16} /> : <Upload size={16} />}
            >
              <form onSubmit={(event) => void submitSource(event)} className="wizard-form">
                <div className={styles.sourceChoices} role="radiogroup" aria-label="Project source">
                  {([
                    { id: "github", icon: <GitBranch size={16} />, title: "GitHub repository", text: "Clone a repo and redeploy it on new commits." },
                    { id: "upload", icon: <Upload size={16} />, title: "Upload files", text: "A docker-compose.yml and any files it needs." },
                  ] as const).map((choice) => (
                    <button
                      key={choice.id}
                      type="button"
                      role="radio"
                      aria-checked={source === choice.id}
                      className={cn(styles.sourceChoice, source === choice.id && styles.sourceChoiceActive)}
                      onClick={() => set({ source: choice.id, error: "" })}
                      disabled={sourceLocked}
                    >
                      <span className={styles.sourceChoiceIcon}>{choice.icon}</span>
                      <span>
                        <strong>{choice.title}</strong>
                        <span>{choice.text}</span>
                      </span>
                    </button>
                  ))}
                </div>

                {isGithub && (
                  <div className="form-row">
                    <div className="field field-wide">
                      <label>GitHub repo <span className="hint mono">(owner/repo or link)</span></label>
                      <input
                        type="text"
                        placeholder="owner/repo"
                        value={state.repo}
                        onChange={(e) => set((s) => ({ repo: e.target.value, name: s.nameEdited ? s.name : nameFromRepo(e.target.value) }))}
                        disabled={sourceFilesLocked}
                        required
                        autoFocus
                      />
                    </div>
                    <div className="field">
                      <label>GitHub token <span className="hint mono">(private repos)</span></label>
                      <GitHubTokenSelect
                        credentials={credentials}
                        value={state.credentialId}
                        onValueChange={(credentialId) => set({ credentialId })}
                        disabled={sourceFilesLocked}
                      />
                    </div>
                  </div>
                )}

                {!isGithub && (
                  <>
                    <div className="field field-wide">
                      <label><FileText size={12} />docker-compose.yml</label>
                      <input type="file" accept=".yml,.yaml" disabled={sourceFilesLocked} onChange={(e) => set({ composeUpload: e.target.files?.[0] ?? null })} />
                      {state.composeUpload && <div className="muted-text">{state.composeUpload.name} ({Math.ceil(state.composeUpload.size / 1024)} KB)</div>}
                    </div>
                    <div className="field field-wide">
                      <label>Support files <span className="hint mono">(optional: configs, Dockerfiles, ...)</span></label>
                      {state.supportFiles.map((supportFile, index) => (
                        <div key={index} className={styles.supportFileRow}>
                          <input
                            type="file"
                            disabled={sourceFilesLocked}
                            onChange={(e) => {
                              const file = e.target.files?.[0] ?? null;
                              set((s) => ({ supportFiles: s.supportFiles.map((f, i) => i === index ? { file, path: f.path || file?.name || "" } : f) }));
                            }}
                          />
                          <input
                            type="text"
                            placeholder="relative path, e.g. nginx/nginx.conf"
                            value={supportFile.path}
                            disabled={sourceFilesLocked}
                            onChange={(e) => set((s) => ({ supportFiles: s.supportFiles.map((f, i) => i === index ? { ...f, path: e.target.value } : f) }))}
                          />
                          <button
                            type="button"
                            className="btn-icon"
                            onClick={() => set((s) => ({ supportFiles: s.supportFiles.filter((_, i) => i !== index) }))}
                            disabled={sourceFilesLocked}
                            aria-label="Remove file"
                          >
                            <X size={14} />
                          </button>
                        </div>
                      ))}
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => set((s) => ({ supportFiles: [...s.supportFiles, { file: null, path: "" }] }))} disabled={sourceFilesLocked}>
                        <Plus size={13} />
                        Add support file
                      </button>
                    </div>
                  </>
                )}

                <div className="form-row">
                  <div className="field field-wide">
                    <label>Name</label>
                    <input type="text" placeholder="My API" value={state.name} onChange={(e) => set({ name: e.target.value, nameEdited: true })} disabled={sourceLocked} required />
                  </div>
                  <ProjectGroupField value={state.groupName} onValueChange={(groupName) => set({ groupName })} projects={projects} disabled={sourceLocked} />
                </div>

                {(state.fetchStatus !== "idle" || state.fetchLog) && (
                  <pre className={cn("output-block wizard-output", state.fetchStatus === "failed" && "output-stderr")}>
                    {state.fetchLog || "Waiting for output..."}
                  </pre>
                )}

                <div className="wizard-actions">
                  <button type="button" className="btn btn-ghost" onClick={() => void requestClose()} disabled={busy}>Cancel</button>
                  <button type="submit" className="btn btn-primary" disabled={busy}>
                    {state.fetchStatus === "running" ? <Loader size={14} className="spin" /> : state.fetchStatus === "failed" ? <RefreshCw size={14} /> : <ArrowRight size={14} />}
                    {state.fetchStatus === "running" ? (isGithub ? "Fetching..." : "Checking files...") : state.fetchStatus === "failed" ? "Retry" : "Continue"}
                  </button>
                </div>
              </form>
            </WizardScreen>
          )}

          {state.stage === "configure" && project && (
            <WizardScreen
              title={`Configure ${project.name}`}
              description="Everything here is optional and can be changed later from the project page."
              icon={<Settings2 size={16} />}
            >
              <Section title="Source" icon={isGithub ? <GitBranch size={12} /> : <Upload size={12} />} aside={<span className="muted-text mono">{isGithub ? project.githubRepo : "Uploaded files"}</span>}>
                <div className="form-row">
                  {isGithub && (
                    <div className="field field-wide">
                      <label>Branch</label>
                      {state.branches.length === 0 ? (
                        <>
                          <input type="text" placeholder="main" value={state.branch} onChange={(e) => set({ branch: e.target.value.trim() })} disabled={busy} />
                          {state.branchesError && <span className="muted-text" title={state.branchesError}>Couldn't list branches from GitHub, so type the name.</span>}
                        </>
                      ) : (
                        <ActionSelect
                          value={state.branch}
                          onValueChange={(branch) => void changeBranch(branch)}
                          disabled={busy}
                          placeholder="Select a branch"
                          options={state.branches.map((branch) => ({ value: branch.name, label: branch.name }))}
                          action={(
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void refreshBranches()} disabled={busy} title="Refresh branches">
                              {state.loadingBranches ? <Loader size={13} className="spin" /> : <RefreshCw size={13} />}
                            </button>
                          )}
                        />
                      )}
                    </div>
                  )}
                  <div className="field field-wide">
                    <label>Compose file</label>
                    {project.availableComposeFiles.length > 1 ? (
                      <AppSelect
                        value={state.composeFile}
                        onValueChange={changeComposeFile}
                        disabled={busy}
                        options={project.availableComposeFiles.map((file) => ({ value: file, label: file }))}
                      />
                    ) : <div className={cn(styles.staticValue, "mono")}>{state.composeFile || "None found"}</div>}
                  </div>
                </div>
                {isGithub && (
                  <div className="field field-wide">
                    <label>New commits on {state.branch || "the branch"}</label>
                    <div className={styles.segmented} role="radiogroup" aria-label="Deploy trigger">
                      {TRIGGER_OPTIONS.map((option) => {
                        const blocked = option.value === "webhook" && !state.webhookAvailable;
                        return (
                          <button
                            key={option.value}
                            type="button"
                            role="radio"
                            aria-checked={state.trigger === option.value}
                            className={cn(styles.segment, state.trigger === option.value && styles.segmentActive)}
                            onClick={() => set({ trigger: option.value })}
                            disabled={blocked || busy}
                            title={blocked ? "Webhooks need StackPort reachable over HTTPS" : option.hint}
                          >
                            {option.label}
                          </button>
                        );
                      })}
                    </div>
                    <span className="muted-text">{TRIGGER_OPTIONS.find((option) => option.value === state.trigger)?.hint}</span>
                  </div>
                )}
              </Section>

              <Section
                title="Environment"
                icon={<FileText size={12} />}
                aside={(
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => set({ envEditorPath: undefined })} disabled={busy}>
                    <Settings2 size={13} />
                    Open env editor
                  </button>
                )}
              >
                {state.envFiles.length === 0 && missingEnvRefs.length === 0 && (
                  <div className="muted-text">No env files yet, and {state.composeFile || "the compose file"} doesn't reference any.</div>
                )}
                <div className={styles.envChips}>
                  {state.envFiles.map((file) => (
                    <button key={file.id} type="button" className={styles.envChip} onClick={() => set({ envEditorPath: file.relativePath })}>
                      <CheckCircle size={12} />
                      <span className="mono">{file.relativePath}</span>
                      <span className={styles.envChipMeta}>{file.variables.length} {file.variables.length === 1 ? "var" : "vars"}</span>
                    </button>
                  ))}
                  {missingEnvRefs.map((ref) => (
                    <button
                      key={ref.path}
                      type="button"
                      className={cn(styles.envChip, ref.required ? styles.envChipMissing : styles.envChipOptional)}
                      onClick={() => set({ envEditorPath: ref.path })}
                      title={`Referenced by ${ref.services.join(", ")}${ref.required ? "" : " (optional)"}`}
                    >
                      <Plus size={12} />
                      <span className="mono">{ref.path}</span>
                      <span className={styles.envChipMeta}>{ref.required ? "missing" : "optional"}</span>
                    </button>
                  ))}
                </div>
                {blockingEnvRefs.length > 0 && (
                  <div className={styles.inlineWarning}>
                    <AlertTriangle size={13} />
                    Docker Compose will refuse to start until {blockingEnvRefs.map((ref) => ref.path).join(", ")} {blockingEnvRefs.length === 1 ? "exists" : "exist"}.
                  </div>
                )}
              </Section>

              <Section title="Routing" icon={<Globe size={12} />} aside={<span className="muted-text">Optional</span>}>
                <div className="form-row">
                  <div className="field field-wide">
                    <label>Domain</label>
                    <input type="text" placeholder="myapp.example.com" value={state.domain} onChange={(e) => set({ domain: e.target.value })} disabled={busy} />
                  </div>
                  <div className="field field-wide">
                    <label>Service and container port</label>
                    <ProjectIngressSelect
                      projectId={project.id}
                      composeFile={state.composeFile || project.composeFile}
                      refreshKey={`${state.checkedOutBranch}|${state.envFiles.length}`}
                      value={state.ingress}
                      disabled={busy}
                      onValueChange={(ingress) => set({ ingress })}
                    />
                  </div>
                </div>
                <label className="wizard-switch-row" style={{ opacity: domain && state.sslReady ? 1 : 0.55 }}>
                  <Switch checked={state.useSsl && !!domain} onCheckedChange={(useSsl) => set({ useSsl })} disabled={!domain || !state.sslReady || busy} />
                  <span>
                    <span><Lock size={12} />Use SSL</span>
                    <span>{!state.sslReady ? "Certbot email or tooling isn't set up" : !domain ? "Set a domain to issue a certificate" : "Issue a Let's Encrypt certificate after the first start"}</span>
                  </span>
                </label>
              </Section>

              <div className="wizard-actions">
                <button type="button" className="btn btn-ghost" onClick={() => void requestClose()} disabled={busy}>
                  {resumeProject ? "Close" : "Cancel"}
                </button>
                <button type="button" className="btn btn-primary" onClick={startDeploy} disabled={busy || routingIncomplete || !state.composeFile || (isGithub && !state.branch)} title={routingIncomplete ? "Pick the service and port the domain should reach" : undefined}>
                  <Rocket size={14} />
                  Deploy
                </button>
              </div>
            </WizardScreen>
          )}

          {state.stage === "deploy" && project && (
            <WizardScreen
              title={state.finished ? `${project.name} is live` : `Deploying ${project.name}`}
              description={state.finished
                ? domain ? `${state.useSsl ? "https" : "http"}://${domain} is routed to ${ingressService}:${ingressPort}.` : "The stack is running. Add a domain any time from the project page."
                : "Each step runs in order. If one fails, fix it and retry from there."}
              icon={state.finished ? <CheckCircle size={16} /> : <Rocket size={16} />}
            >
              <ol className={styles.deploySteps}>
                {deploySteps.map((step) => (
                  <li key={step.id} className={cn(styles.deployStep, DEPLOY_STEP_CLASS[state.steps[step.id]])}>
                    <StatusIcon status={state.steps[step.id]} />
                    <span>{step.label}</span>
                  </li>
                ))}
              </ol>
              <pre className={cn("output-block wizard-output", failedStep && "output-stderr")}>
                {state.deployLog || "Waiting for output..."}
              </pre>
              <div className="wizard-actions">
                {state.finished ? (
                  <>
                    <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
                    {!resumeProject && (
                      <button type="button" className="btn btn-secondary" onClick={addAnother}>
                        <Plus size={14} />
                        Add another
                      </button>
                    )}
                    <button type="button" className="btn btn-primary" onClick={openProject}>
                      <FolderDot size={14} />
                      Open project
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" className="btn btn-ghost" onClick={() => set({ stage: "configure", error: "" })} disabled={busy}>Back to configure</button>
                    {failedStep && (
                      <button type="button" className="btn btn-primary" onClick={() => void runDeploy(failedStep.id)} disabled={busy}>
                        <RefreshCw size={14} />
                        Retry {failedStep.label.toLowerCase()}
                      </button>
                    )}
                  </>
                )}
              </div>
            </WizardScreen>
          )}
        </div>
      </div>

      {project && state.envEditorPath !== null && (
        <EnvManagerDialog
          projectId={project.id}
          projectName={project.name}
          envFiles={state.envFiles}
          initialPath={state.envEditorPath}
          onEnvFilesChange={(envFiles) => set({ envFiles })}
          onClose={() => set({ envEditorPath: null })}
        />
      )}
    </>
  );
}
