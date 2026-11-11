import { projectRepoDir } from "../../modules/projects/workspace";
import { createProjectEnvFile, deleteProjectEnvFile, EnvFileUnreadableError, listProjectEnvFiles, normalizeEnvRelativePath, parseEnvVariables, updateProjectEnvFile } from "../../modules/projects/envFiles";
import { previewDeploy, previewRollback } from "../../modules/deployments/preview";
import { Router, Request, Response, NextFunction } from "express";
import { getDatabase } from "../../config/database";
import { requireAuth } from "../../modules/identity/middleware/session";
import { auditLog } from "../../shared/logger";
import { rowToProject, DEPLOY_TRIGGERS, type DeployTrigger, type ProjectRow } from "../../modules/projects/types";
import { clearPendingAutoDeploy } from "../../modules/automation/autoDeploy";
import { disableWebhook, enableWebhook, getWebhookDetails, pingWebhook, reinstallWebhook, webhookBaseUrl } from "../../modules/automation/githubWebhooks";
import { healthChecker } from "../../modules/deployments/health";
import { writeNginxConfig } from "../../modules/ingress/nginx/configWriter";
import { emitGlobalEvent, emitProjectDataUpdate } from "../realtime";
import {
  buildProject,
  cleanOrphanFolder,
  composeProject,
  deployProject,
  ensureProjectProxyNetwork,
  leaveNetworkGroup,
  getProjectById,
  getProjectComposeEnvFiles,
  getProjectComposeVariables,
  getProjectComposePolicy,
  getProjectIngressTargets,
  getProjectComposeFileContent,
  getProjectLogs,
  isValidBranchName,
  forceRebuildProject,
  pullProject,
  recreateProject,
  renameProjectRepoFolder,
  rollbackProject,
  dropProjectServiceVolumes,
  redeployProjectService,
  scanComposeFiles,
  scanProjectRepoFolders,
  serviceExistsInCompose,
  stopProject,
  stopAndPurgeProject,
  validateComposeFileChoice,
} from "../../modules/deployments/operations";
import { setComposePolicyEnforced } from "../../modules/deployments/compose/enforcement";
import { getProjectBranches } from "../../modules/automation/githubPolling";
import { runCertbotAction } from "../../modules/ingress/certificates/operations";
import { actionRegistry, DEPLOY_KINDS_SQL, projectRepoKey, projectSslKey, projectSslKeyPrefix, respondActionStarted, respondActionBusy } from "../../modules/actions/registry";
import { deleteProjectActionLogs } from "../../modules/actions/log";
import { clampHours, getProjectResourceSnapshot, getProjectResourcesSummary, getProjectResourcesTimeseries, type ResourceMetric } from "../../modules/observability/queries/projectResources";
import { createProject as adminCreateProject, updateProject, setProjectPaused as pauseProject, ProjectAdminError } from "../../modules/projects/operations";
import {
  addProjectDomain,
  attachDomains,
  getProjectDomain,
  listProjectDomains,
  parseContainerPort,
  parseServiceName,
  ProjectDomainError,
  removeProjectDomain,
  setProjectDomainRoute,
  setProjectDomainSsl,
} from "../../modules/ingress/domains";
import { stageAndApplyUpload } from "../../modules/deployments/upload";
import { listProjectDeployments, resolveRollbackTarget } from "../../modules/deployments/history";
import {
  deleteTcpExposure,
  findPublishedPortConflict,
  insertTcpExposure,
  listTcpExposures,
  reconcileTcpExposure,
  removeProjectTcpRuntime,
  type TcpExposure,
  TcpExposureError,
} from "../../modules/ingress/tcp";
import { removeIngressNetwork } from "../../modules/ingress/networks";
import { assignNetworkGroup, getNetworkGroupView, NetworkGroupError } from "../../modules/deployments/networkGroupAssignment";
import multer from "multer";

const router = Router();

function nginxFlowId(source: string, projectId?: number): string {
  return `${source}:${projectId ?? "all"}:${Date.now()}`;
}

function emitNginxFlow(event: {
  id: string;
  status: "started" | "success" | "failed";
  source: string;
  projectId?: number;
  projectName?: string;
  domainId?: number;
  message: string;
  output?: string;
}): void {
  emitGlobalEvent({
    id: event.id,
    type: "nginx:flow",
    status: event.status,
    title: event.status === "started" ? "Applying nginx config" : event.status === "success" ? "Nginx config applied" : "Nginx config failed",
    message: event.message,
    projectId: event.projectId,
    projectName: event.projectName,
    domainId: event.domainId,
    output: event.output,
    createdAt: new Date().toISOString(),
  });
}

async function runProjectNginxFlow(source: string, project: { id: number; name: string }): Promise<void> {
  const id = nginxFlowId(source, project.id);
  emitNginxFlow({
    id,
    status: "started",
    source,
    projectId: project.id,
    projectName: project.name,
    message: `${project.name}: rebuilding nginx routes.`,
  });
  try {
    await ensureProjectProxyNetwork(project.id);
    const result = await writeNginxConfig();
    emitNginxFlow({
      id,
      status: result.ok ? "success" : "failed",
      source,
      projectId: project.id,
      projectName: project.name,
      message: result.ok ? `${project.name}: nginx routes are live.` : `${project.name}: nginx apply failed.`,
      output: result.output,
    });
  } catch (err) {
    emitNginxFlow({
      id,
      status: "failed",
      source,
      projectId: project.id,
      projectName: project.name,
      message: `${project.name}: nginx apply failed.`,
      output: err instanceof Error ? err.message : String(err),
    });
  }
}

router.get("/", requireAuth, (_req: Request, res: Response): void => {
  const rows = getDatabase()
    .prepare("SELECT * FROM projects ORDER BY favorite DESC, name ASC")
    .all() as ProjectRow[];
  res.json(attachDomains(rows.map(rowToProject)));
});

router.get("/repo-folder-scan", requireAuth, async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await scanProjectRepoFolders();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to scan repo folders" });
  }
});

router.post("/repo-folder-scan/rename", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { projectId, folder } = req.body as { projectId?: number; folder?: string };
  if (typeof projectId !== "number" || !Number.isInteger(projectId) || projectId <= 0) {
    res.status(400).json({ error: "projectId is required" });
    return;
  }
  if (!folder || typeof folder !== "string") {
    res.status(400).json({ error: "folder is required" });
    return;
  }
  try {
    const result = await renameProjectRepoFolder(projectId, folder);
    auditLog(req.user ?? "unknown", "repo-folder.rename", `${projectId}:${folder}`, result.ok ? "ok" : "fail");
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Rename failed" });
  }
});

router.post("/repo-folder-scan/cleanup", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { path: folderPath } = req.body as { path?: string };
  if (!folderPath || typeof folderPath !== "string") {
    res.status(400).json({ error: "path is required" });
    return;
  }
  try {
    const result = await cleanOrphanFolder(folderPath);
    auditLog(req.user ?? "unknown", "repo-folder.cleanup", folderPath, result.ok ? "ok" : "fail");
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Cleanup failed" });
  }
});

// Registered before `/:id` — Express matches routes in registration order, and
// `/:id`'s parseInt would otherwise swallow this literal path as an invalid id.
router.get("/resources-summary", requireAuth, (req: Request, res: Response): void => {
  res.json({ projects: getProjectResourcesSummary(clampHours(req.query.hours)) });
});

const RESOURCE_METRICS = new Set(["cpu", "mem", "net", "disk"]);

// GET /resources-timeseries?hours=24&metric=cpu&projectIds=1,2,3 — per-project bucketed
// series for the Metrics page's stacked area chart. projectIds omitted/empty = all projects.
router.get("/resources-timeseries", requireAuth, (req: Request, res: Response): void => {
  const metric = typeof req.query.metric === "string" ? req.query.metric : "cpu";
  if (!RESOURCE_METRICS.has(metric)) { res.status(400).json({ error: "Invalid metric" }); return; }

  const projectIdsParam = typeof req.query.projectIds === "string" ? req.query.projectIds : "";
  const projectIds = projectIdsParam
    ? projectIdsParam.split(",").map((v) => parseInt(v, 10)).filter((n) => !isNaN(n))
    : null;

  res.json(getProjectResourcesTimeseries(projectIds, clampHours(req.query.hours), metric as ResourceMetric));
});

router.get("/:id", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const row = getDatabase().prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
  if (!row) { res.status(404).json({ error: "Project not found" }); return; }

  res.json({ ...rowToProject(row), domains: listProjectDomains(id) });
});

// GET /:id/resources?hours=24 — latest sample plus 5-minute bucketed history for the project's compose stack
router.get("/:id/resources", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!getDatabase().prepare("SELECT id FROM projects WHERE id = ?").get(id)) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  res.json(getProjectResourceSnapshot(id, clampHours(req.query.hours)));
});

router.get("/:id/env-files", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!getDatabase().prepare("SELECT id FROM projects WHERE id = ?").get(id)) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  res.json(listProjectEnvFiles(id));
});

router.post("/:id/env-files", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!getDatabase().prepare("SELECT id FROM projects WHERE id = ?").get(id)) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const { relativePath, variables } = req.body as Record<string, unknown>;
  if (typeof relativePath !== "string") {
    res.status(400).json({ error: "relativePath is required" });
    return;
  }
  const normalizedPath = normalizeEnvRelativePath(relativePath);
  const parsedVariables = parseEnvVariables(variables);
  if (!normalizedPath || !parsedVariables) {
    res.status(400).json({ error: "Env file needs a safe .env relative path and unique KEY=value pairs" });
    return;
  }
  if (getDatabase().prepare("SELECT id FROM project_env_files WHERE project_id = ? AND relative_path = ?").get(id, normalizedPath)) {
    res.status(409).json({ error: "An env file with that path already exists" });
    return;
  }

  const envFile = createProjectEnvFile(id, normalizedPath, parsedVariables);
  auditLog(req.user ?? "unknown", "project.env-create", `${id}:${normalizedPath}`, "ok");
  res.status(201).json(envFile);
});

router.put("/:id/env-files/:envId", requireAuth, (req: Request<{ id: string; envId: string }>, res: Response): void => {
  const id = parseInt(req.params.id, 10);
  const envId = parseInt(req.params.envId, 10);
  if (isNaN(id) || isNaN(envId)) { res.status(400).json({ error: "Invalid id" }); return; }

  const { relativePath, variables } = req.body as Record<string, unknown>;
  if (typeof relativePath !== "string") {
    res.status(400).json({ error: "relativePath is required" });
    return;
  }
  const normalizedPath = normalizeEnvRelativePath(relativePath);
  const parsedVariables = parseEnvVariables(variables);
  if (!normalizedPath || !parsedVariables) {
    res.status(400).json({ error: "Env file needs a safe .env relative path and unique KEY=value pairs" });
    return;
  }
  if (getDatabase().prepare("SELECT id FROM project_env_files WHERE project_id = ? AND relative_path = ? AND id <> ?").get(id, normalizedPath, envId)) {
    res.status(409).json({ error: "An env file with that path already exists" });
    return;
  }

  let envFile;
  try {
    envFile = updateProjectEnvFile(envId, id, normalizedPath, parsedVariables);
  } catch (err) {
    if (err instanceof EnvFileUnreadableError) { res.status(409).json({ error: err.message }); return; }
    throw err;
  }
  if (!envFile) {
    res.status(404).json({ error: "Env file not found" });
    return;
  }

  auditLog(req.user ?? "unknown", "project.env-update", `${id}:${normalizedPath}`, "ok");
  res.json(envFile);
});

router.delete("/:id/env-files/:envId", requireAuth, (req: Request<{ id: string; envId: string }>, res: Response): void => {
  const id = parseInt(req.params.id, 10);
  const envId = parseInt(req.params.envId, 10);
  if (isNaN(id) || isNaN(envId)) { res.status(400).json({ error: "Invalid id" }); return; }

  if (!deleteProjectEnvFile(envId, id)) {
    res.status(404).json({ error: "Env file not found" });
    return;
  }

  auditLog(req.user ?? "unknown", "project.env-delete", `${id}:${envId}`, "ok");
  res.status(204).send();
});

router.post("/:id/build", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!getProjectById(id)) { res.status(404).json({ error: "Project not found" }); return; }

  const user = req.user ?? "unknown";
  const key = projectRepoKey(id);
  const started = actionRegistry.tryStart(key, "build", { projectId: id }, async () => {
    const result = await buildProject(id);
    auditLog(user, "project.build", String(id), result.ok ? "ok" : "fail", {
      repoPath: result.repoPath,
    });
    return { ok: result.ok, output: result.output };
  });
  if (!started) { respondActionBusy(res, key, "An action is already running for this project"); return; }
  respondActionStarted(res, started);
});

router.post("/:id/pull", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!getProjectById(id)) { res.status(404).json({ error: "Project not found" }); return; }

  const rawBranch = typeof req.body?.branch === "string" ? req.body.branch.trim() : "";
  if (rawBranch && !isValidBranchName(rawBranch)) {
    res.status(400).json({ error: "Invalid branch name" });
    return;
  }
  const branch = rawBranch || null;

  const user = req.user ?? "unknown";
  const key = projectRepoKey(id);
  const started = actionRegistry.tryStart(key, "pull", { projectId: id }, async () => {
    const result = await pullProject(id, branch);
    auditLog(user, "project.pull", String(id), result.ok ? "ok" : "fail", {
      repoPath: result.repoPath,
      ...(branch ? { branch } : {}),
    });
    return { ok: result.ok, output: result.output };
  });
  if (!started) { respondActionBusy(res, key, "An action is already running for this project"); return; }
  respondActionStarted(res, started);
});

const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 31 },
}).fields([
  { name: "composeFile", maxCount: 1 },
  { name: "files", maxCount: 30 },
]);

function handleUpload(req: Request, res: Response, next: NextFunction): void {
  uploadMiddleware(req, res, (err: unknown) => {
    if (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Upload failed" });
      return;
    }
    next();
  });
}

router.post("/:id/upload", requireAuth, handleUpload, (req: Request<{ id: string }>, res: Response): void => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const project = getProjectById(id);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  if (project.sourceType !== "upload") {
    res.status(400).json({ error: "Project is not configured for manual upload" });
    return;
  }

  const files = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
  const composeFiles = files["composeFile"] ?? [];
  const supportFiles = files["files"] ?? [];

  if (composeFiles.length !== 1) {
    res.status(400).json({ error: "Exactly one composeFile is required" });
    return;
  }

  let paths: unknown;
  try {
    paths = req.body?.paths ? JSON.parse(String(req.body.paths)) : [];
  } catch {
    res.status(400).json({ error: "paths must be a JSON array" });
    return;
  }
  if (!Array.isArray(paths) || paths.length !== supportFiles.length || !paths.every((p) => typeof p === "string")) {
    res.status(400).json({ error: "paths must be a JSON array of strings matching the number of uploaded support files" });
    return;
  }
  const supportPaths = paths as string[];
  // "false" stages and validates only, so setup can configure env files and routing before the first start.
  const deploy = req.body?.deploy !== "false";

  const user = req.user ?? "unknown";
  const key = projectRepoKey(id);
  const started = actionRegistry.tryStart(key, "upload", { projectId: id }, async () => {
    const result = await stageAndApplyUpload(
      id,
      { relativePath: composeFiles[0].originalname, buffer: composeFiles[0].buffer },
      supportFiles.map((file, index) => ({ relativePath: supportPaths[index], buffer: file.buffer })),
      { deploy },
    );
    auditLog(user, "project.upload", String(id), result.ok ? "ok" : "fail", { repoPath: result.repoPath });
    return { ok: result.ok, output: result.output };
  });
  if (!started) { respondActionBusy(res, key, "An action is already running for this project"); return; }
  respondActionStarted(res, started);
});

router.post("/:id/compose", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!getProjectById(id)) { res.status(404).json({ error: "Project not found" }); return; }

  const user = req.user ?? "unknown";
  const key = projectRepoKey(id);
  const started = actionRegistry.tryStart(key, "compose", { projectId: id }, async () => {
    const result = await composeProject(id);
    auditLog(user, "project.compose", String(id), result.ok ? "ok" : "fail", {
      repoPath: result.repoPath,
    });
    return { ok: result.ok, output: result.output };
  });
  if (!started) { respondActionBusy(res, key, "An action is already running for this project"); return; }
  respondActionStarted(res, started);
});

router.post("/:id/recreate", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!getProjectById(id)) { res.status(404).json({ error: "Project not found" }); return; }

  const user = req.user ?? "unknown";
  const key = projectRepoKey(id);
  const started = actionRegistry.tryStart(key, "recreate", { projectId: id }, async () => {
    const result = await recreateProject(id);
    auditLog(user, "project.recreate", String(id), result.ok ? "ok" : "fail", {
      repoPath: result.repoPath,
    });
    return { ok: result.ok, output: result.output };
  });
  if (!started) { respondActionBusy(res, key, "An action is already running for this project"); return; }
  respondActionStarted(res, started);
});

router.get("/:id/deployments", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!getProjectById(id)) { res.status(404).json({ error: "Project not found" }); return; }
  res.json(listProjectDeployments(id));
});

/** What a deploy would change; read-only. `?branch=` as for POST /:id/deploy. */
router.get("/:id/deploy-preview", requireAuth, async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const project = getProjectById(id);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const rawBranch = typeof req.query["branch"] === "string" ? req.query["branch"].trim() : "";
  if (rawBranch && !isValidBranchName(rawBranch)) { res.status(400).json({ error: "Invalid branch name" }); return; }
  res.json(await previewDeploy(project, rawBranch || null));
});

/** What a rollback would change; read-only. `?deploymentId=` as for POST /:id/rollback. */
router.get("/:id/rollback-preview", requireAuth, async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const project = getProjectById(id);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const raw = req.query["deploymentId"];
  let deploymentId: number | undefined;
  if (raw !== undefined) {
    deploymentId = typeof raw === "string" && /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
    if (!Number.isInteger(deploymentId) || deploymentId <= 0) { res.status(400).json({ error: "deploymentId must be a positive integer" }); return; }
  }
  const result = await previewRollback(project, deploymentId);
  if (!result.ok) { res.status(409).json({ error: result.error }); return; }
  res.json({ ...result.preview, targetId: result.targetId });
});

router.post("/:id/rollback", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!getProjectById(id)) { res.status(404).json({ error: "Project not found" }); return; }

  const rawDeploymentId: unknown = req.body?.deploymentId;
  if (rawDeploymentId !== undefined && rawDeploymentId !== null
    && !(typeof rawDeploymentId === "number" && Number.isInteger(rawDeploymentId) && rawDeploymentId > 0)) {
    res.status(400).json({ error: "deploymentId must be a positive integer" });
    return;
  }
  const deploymentId = typeof rawDeploymentId === "number" ? rawDeploymentId : undefined;
  // Checked again when the rollback runs; this is for an immediate, clear answer.
  const target = resolveRollbackTarget(id, deploymentId);
  if (!target.ok) { res.status(409).json({ error: target.error }); return; }

  const user = req.user ?? "unknown";
  const key = projectRepoKey(id);
  const started = actionRegistry.tryStart(key, "rollback", { projectId: id, deploymentId: target.target.id }, async () => {
    // The resolved id, so the revision that runs is the one announced in the response.
    const result = await rollbackProject(id, target.target.id);
    auditLog(user, "project.rollback", String(id), result.ok ? "ok" : "fail", {
      repoPath: result.repoPath,
      deploymentId: target.target.id,
    });
    return { ok: result.ok, output: result.output };
  });
  if (!started) { respondActionBusy(res, key, "An action is already running for this project"); return; }
  respondActionStarted(res, started);
});

const SERVICE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** Rebuild + restart a single compose service without touching the rest of the
 *  stack — for multi-container projects where redeploying everything to pick up a
 *  change in one service is unnecessary churn. Shares the project's repo action
 *  slot with every other compose action, so it's mutually exclusive with them. */
router.post("/:id/containers/:service/redeploy", requireAuth, (req: Request<{ id: string; service: string }>, res: Response): void => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!getProjectById(id)) { res.status(404).json({ error: "Project not found" }); return; }
  const service = req.params.service;
  if (!SERVICE_NAME_RE.test(service)) { res.status(400).json({ error: "Invalid service name" }); return; }

  const user = req.user ?? "unknown";
  const key = projectRepoKey(id);
  const started = actionRegistry.tryStart(key, "redeploy-service", { projectId: id, service }, async () => {
    const result = await redeployProjectService(id, service);
    auditLog(user, "project.redeploy-service", `${id}:${service}`, result.ok ? "ok" : "fail", {
      repoPath: result.repoPath,
    });
    return { ok: result.ok, output: result.output };
  });
  if (!started) { respondActionBusy(res, key, "An action is already running for this project"); return; }
  respondActionStarted(res, started);
});

/** Stops and removes a single compose service's container along with every volume
 *  mounted into it — destructive and irreversible, the client is expected to confirm
 *  with the user before calling this. Shares the project's repo action slot. */
router.post("/:id/containers/:service/drop-volumes", requireAuth, (req: Request<{ id: string; service: string }>, res: Response): void => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!getProjectById(id)) { res.status(404).json({ error: "Project not found" }); return; }
  const service = req.params.service;
  if (!SERVICE_NAME_RE.test(service)) { res.status(400).json({ error: "Invalid service name" }); return; }

  const user = req.user ?? "unknown";
  const key = projectRepoKey(id);
  const started = actionRegistry.tryStart(key, "drop-volumes", { projectId: id, service }, async () => {
    const result = await dropProjectServiceVolumes(id, service);
    auditLog(user, "project.drop-volumes", `${id}:${service}`, result.ok ? "ok" : "fail", {
      repoPath: result.repoPath,
    });
    return { ok: result.ok, output: result.output };
  });
  if (!started) { respondActionBusy(res, key, "An action is already running for this project"); return; }
  respondActionStarted(res, started);
});

router.post("/:id/force-rebuild", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!getProjectById(id)) { res.status(404).json({ error: "Project not found" }); return; }

  const user = req.user ?? "unknown";
  const key = projectRepoKey(id);
  const started = actionRegistry.tryStart(key, "force-rebuild", { projectId: id }, async () => {
    const result = await forceRebuildProject(id);
    auditLog(user, "project.force-rebuild", String(id), result.ok ? "ok" : "fail", {
      repoPath: result.repoPath,
    });
    return { ok: result.ok, output: result.output };
  });
  if (!started) { respondActionBusy(res, key, "An action is already running for this project"); return; }
  respondActionStarted(res, started);
});

router.post("/:id/deploy", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!getProjectById(id)) { res.status(404).json({ error: "Project not found" }); return; }

  const rawBranch = typeof req.body?.branch === "string" ? req.body.branch.trim() : "";
  if (rawBranch && !isValidBranchName(rawBranch)) {
    res.status(400).json({ error: "Invalid branch name" });
    return;
  }
  const branch = rawBranch || null;

  const user = req.user ?? "unknown";
  const key = projectRepoKey(id);
  const started = actionRegistry.tryStart(key, "deploy", { projectId: id, ...(branch ? { branch } : {}) }, async () => {
    const result = await deployProject(id, "manual", branch);
    auditLog(user, "project.deploy", String(id), result.ok ? "ok" : "fail", {
      repoPath: result.repoPath,
      ...(branch ? { branch } : {}),
    });
    return { ok: result.ok, output: result.output };
  });
  if (!started) { respondActionBusy(res, key, "An action is already running for this project"); return; }
  respondActionStarted(res, started);
});

router.get("/:id/ingress-targets", requireAuth, async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!getProjectById(id)) { res.status(404).json({ error: "Project not found" }); return; }
  if (req.query.composeFile !== undefined && typeof req.query.composeFile !== "string") { res.status(400).json({ error: "Invalid Compose file" }); return; }
  try { res.json(await getProjectIngressTargets(id, req.query.composeFile as string | undefined)); }
  catch (err) { res.status(400).json({ error: (err as Error).message }); }
});

router.get("/:id/compose-env-files", requireAuth, async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!getProjectById(id)) { res.status(404).json({ error: "Project not found" }); return; }
  if (req.query.composeFile !== undefined && typeof req.query.composeFile !== "string") { res.status(400).json({ error: "Invalid Compose file" }); return; }
  try { res.json(await getProjectComposeEnvFiles(id, req.query.composeFile as string | undefined)); }
  catch (err) { res.status(400).json({ error: (err as Error).message }); }
});

/** Variables the Compose file interpolates and whether the root `.env` defines them. */
router.get("/:id/compose-variables", requireAuth, async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!getProjectById(id)) { res.status(404).json({ error: "Project not found" }); return; }
  if (req.query.composeFile !== undefined && typeof req.query.composeFile !== "string") { res.status(400).json({ error: "Invalid Compose file" }); return; }
  try { res.json(await getProjectComposeVariables(id, req.query.composeFile as string | undefined)); }
  catch (err) { res.status(400).json({ error: (err as Error).message }); }
});

/** Policy violations in the selected Compose file of the checkout. No checkout or no
 *  file selected yet is not an error here: there is just nothing to check. */
router.get("/:id/compose-policy", requireAuth, async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!getProjectById(id)) { res.status(404).json({ error: "Project not found" }); return; }
  try { res.json(await getProjectComposePolicy(id)); }
  catch { res.json({ composeFile: null, violations: [], resolved: { checked: false, violations: [] }, enforced: true }); }
});

/** Rejects (true) or only warns about (false) resolved-config policy violations (S1) for one
 *  project; applies on its next deploy. Older projects start with it off. */
router.put("/:id/compose-policy-enforcement", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: "Invalid id" }); return; }
  const enforced: unknown = req.body?.enforced;
  if (typeof enforced !== "boolean") { res.status(400).json({ error: "enforced must be true or false" }); return; }
  if (!setComposePolicyEnforced(id, enforced)) { res.status(404).json({ error: "Project not found" }); return; }
  auditLog(req.user ?? "unknown", "project.compose-policy-enforcement", String(id), "ok", { enforced });
  res.json({ composePolicyEnforced: enforced });
});

/** Turns the hardened container defaults (S8) on or off for one project; they take
 *  effect on its next deploy. */
router.put("/:id/hardening", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!getProjectById(id)) { res.status(404).json({ error: "Project not found" }); return; }
  const enabled: unknown = req.body?.enabled;
  if (typeof enabled !== "boolean") { res.status(400).json({ error: "enabled must be true or false" }); return; }
  getDatabase().prepare("UPDATE projects SET hardened_defaults = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(enabled ? 1 : 0, id);
  auditLog(req.user ?? "unknown", "project.hardening", String(id), "ok", { enabled });
  res.json({ hardenedDefaults: enabled });
});

router.get("/:id/network-group", requireAuth, async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!getProjectById(id)) { res.status(404).json({ error: "Project not found" }); return; }
  res.json(await getNetworkGroupView(id));
});

/** Sets the project's network group and which of its services join the group's network. Applied to
 *  the running containers straight away and re-applied after every deploy. */
router.put("/:id/network-group", requireAuth, async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const { assignment, applied, warning } = await assignNetworkGroup(id, req.body?.group, req.body?.services);
    auditLog(req.user ?? "unknown", "project.network-group", String(id), "ok", { group: assignment.group, services: assignment.services });
    res.json({ ...(await getNetworkGroupView(id)), applied, ...(warning ? { warning } : {}) });
  } catch (err) {
    if (err instanceof NetworkGroupError) { res.status(err.statusCode).json({ error: err.message }); return; }
    throw err;
  }
});

router.get("/:id/domains", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!getProjectById(id)) { res.status(404).json({ error: "Project not found" }); return; }
  res.json(listProjectDomains(id));
});

router.get("/:id/tcp-exposures", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!getProjectById(id)) { res.status(404).json({ error: "Project not found" }); return; }
  res.json(listTcpExposures(id));
});

/** Phase 1.7 — confirms `service` is a real service in the project's current compose
 *  file before it's ever written to a domain row, same protection
 *  serviceExistsInCompose already gives every other single-service action. */
async function validateDomainRoute(project: { id: number; name: string; composeFile: string | null }, service: unknown, containerPort: unknown): Promise<{ ok: true; service: string; containerPort: number } | { ok: false; error: string }> {
  const parsedService = parseServiceName(service);
  if (!parsedService) return { ok: false, error: "service must be a valid compose service name" };
  const parsedPort = parseContainerPort(containerPort);
  if (!parsedPort) return { ok: false, error: "containerPort must be a TCP port from 1 to 65535" };
  if (!project.composeFile) return { ok: false, error: "Project has no active compose file yet — pull the repository first" };

  const repoPath = projectRepoDir(project);
  const exists = await serviceExistsInCompose(repoPath, project.composeFile, parsedService);
  if (!exists) return { ok: false, error: `Service "${parsedService}" was not found in ${project.composeFile}` };
  try {
    const targets = await getProjectIngressTargets(project.id);
    if (!targets.some(target => target.service === parsedService && target.containerPort === parsedPort)) {
      return { ok: false, error: `Port ${parsedPort} is not declared for service "${parsedService}" in ${project.composeFile}` };
    }
  } catch (err) { return { ok: false, error: (err as Error).message }; }

  return { ok: true, service: parsedService, containerPort: parsedPort };
}

router.post("/:id/tcp-exposures", requireAuth, async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: "Invalid id" }); return; }
  const project = getProjectById(id);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const publicPort = parseContainerPort((req.body as Record<string, unknown>).publicPort);
  if (!publicPort) { res.status(400).json({ error: "publicPort must be a TCP port from 1 to 65535" }); return; }
  const { service, containerPort } = req.body as Record<string, unknown>;
  const route = await validateDomainRoute(project, service, containerPort);
  if (!route.ok) { res.status(400).json({ error: route.error }); return; }

  let created: TcpExposure | undefined;
  try {
    const conflict = await findPublishedPortConflict(publicPort);
    if (conflict) throw new TcpExposureError(409, `Port ${publicPort} is already published by ${conflict}.`);
    const exposure = insertTcpExposure(id, publicPort, route.service, route.containerPort);
    created = exposure;
    await ensureProjectProxyNetwork(id);
    await reconcileTcpExposure(exposure);
    created = listTcpExposures(id).find((item) => item.id === exposure.id) ?? exposure;
  } catch (err) {
    if (created) await deleteTcpExposure(id, created.id).catch(() => undefined);
    if (err instanceof TcpExposureError) { res.status(err.statusCode).json({ error: err.message }); return; }
    res.status(502).json({ error: err instanceof Error ? err.message : "Failed to create TCP exposure" });
    return;
  }

  auditLog(req.user ?? "unknown", "project.tcp-exposure-add", `${project.name}:${publicPort}`, "ok", {
    service: route.service, containerPort: route.containerPort,
  });
  res.status(201).json(created);
});

router.delete("/:id/tcp-exposures/:exposureId", requireAuth, async (req: Request<{ id: string; exposureId: string }>, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  const exposureId = Number(req.params.exposureId);
  if (!Number.isInteger(id) || id < 1 || !Number.isInteger(exposureId) || exposureId < 1) {
    res.status(400).json({ error: "Invalid id" }); return;
  }
  const project = getProjectById(id);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  try {
    if (!(await deleteTcpExposure(id, exposureId))) { res.status(404).json({ error: "TCP exposure not found" }); return; }
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "Failed to remove TCP proxy" }); return;
  }
  auditLog(req.user ?? "unknown", "project.tcp-exposure-remove", project.name, "ok", { exposureId });
  res.json({ ok: true });
});

router.post("/:id/domains", requireAuth, async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const project = getProjectById(id);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { domain, service, containerPort } = req.body as Record<string, unknown>;
  const route = await validateDomainRoute(project, service, containerPort);
  if (!route.ok) { res.status(400).json({ error: route.error }); return; }

  let created;
  try {
    created = addProjectDomain(id, domain, false, route.service, route.containerPort);
  } catch (err) {
    if (err instanceof ProjectDomainError) { res.status(err.statusCode).json({ error: err.message }); return; }
    throw err;
  }

  auditLog(req.user ?? "unknown", "project.domain-add", `${project.name}:${created.domain}`, "ok", { service: route.service, containerPort: route.containerPort });
  healthChecker.schedule(project);
  res.json(created);
  void runProjectNginxFlow("project.domain-add", project);
});

router.patch("/:id/domains/:domainId/route", requireAuth, async (req: Request<{ id: string; domainId: string }>, res: Response): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const domainId = parseInt(req.params.domainId, 10);
  if (isNaN(id) || isNaN(domainId)) { res.status(400).json({ error: "Invalid id" }); return; }
  const project = getProjectById(id);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { service, containerPort } = req.body as Record<string, unknown>;
  const route = await validateDomainRoute(project, service, containerPort);
  if (!route.ok) { res.status(400).json({ error: route.error }); return; }

  const updated = setProjectDomainRoute(id, domainId, route.service, route.containerPort);
  if (!updated) { res.status(404).json({ error: "Domain not found" }); return; }

  auditLog(req.user ?? "unknown", "project.domain-route", `${project.name}:${updated.domain}`, "ok", { service: route.service, containerPort: route.containerPort });
  res.json(updated);
  void runProjectNginxFlow("project.domain-route", project);
});

router.delete("/:id/domains/:domainId", requireAuth, (req: Request<{ id: string; domainId: string }>, res: Response): void => {
  const id = parseInt(req.params.id, 10);
  const domainId = parseInt(req.params.domainId, 10);
  if (isNaN(id) || isNaN(domainId)) { res.status(400).json({ error: "Invalid id" }); return; }
  const project = getProjectById(id);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const removed = removeProjectDomain(id, domainId);
  if (!removed) { res.status(404).json({ error: "Domain not found" }); return; }

  auditLog(req.user ?? "unknown", "project.domain-remove", project.name, "ok", { domainId });
  healthChecker.schedule(project);
  res.json({ ok: true });
  void runProjectNginxFlow("project.domain-remove", project);
});

router.patch("/:id/domains/:domainId", requireAuth, (req: Request<{ id: string; domainId: string }>, res: Response): void => {
  const id = parseInt(req.params.id, 10);
  const domainId = parseInt(req.params.domainId, 10);
  if (isNaN(id) || isNaN(domainId)) { res.status(400).json({ error: "Invalid id" }); return; }
  const project = getProjectById(id);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { useSsl } = req.body as Record<string, unknown>;
  if (typeof useSsl !== "boolean") { res.status(400).json({ error: "useSsl is required" }); return; }

  const updated = setProjectDomainSsl(id, domainId, useSsl);
  if (!updated) { res.status(404).json({ error: "Domain not found" }); return; }

  auditLog(req.user ?? "unknown", "project.domain-ssl", `${project.name}:${updated.domain}`, "ok", { useSsl });
  res.json(updated);
  void runProjectNginxFlow("project.domain-ssl", project);
});

router.post("/:id/domains/:domainId/ssl/issue", requireAuth, (req: Request<{ id: string; domainId: string }>, res: Response): void => {
  const id = parseInt(req.params.id, 10);
  const domainId = parseInt(req.params.domainId, 10);
  if (isNaN(id) || isNaN(domainId)) { res.status(400).json({ error: "Invalid id" }); return; }

  const project = getProjectById(id);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const domainRow = getProjectDomain(id, domainId);
  if (!domainRow) { res.status(404).json({ error: "Domain not found" }); return; }
  if (!domainRow.service || !domainRow.containerPort) {
    res.status(400).json({ error: "Domain needs a Compose service and container port before SSL can be issued" });
    return;
  }

  const user = req.user ?? "unknown";
  const key = projectSslKey(id, domainId);
  const started = actionRegistry.tryStart(key, "ssl-issue", { projectId: id, domainId, domain: domainRow.domain }, async () => {
    const flowId = nginxFlowId("project.ssl-issue", id);
    emitNginxFlow({
      id: flowId,
      status: "started",
      source: "project.ssl-issue",
      projectId: id,
      projectName: `${project.name} (${domainRow.domain})`,
      domainId,
      message: `${project.name}: preparing HTTP route for certificate issuance on ${domainRow.domain}.`,
    });

    setProjectDomainSsl(id, domainId, false);
    await ensureProjectProxyNetwork(id);
    const preApply = await writeNginxConfig();
    if (!preApply.ok) {
      emitNginxFlow({
        id: flowId,
        status: "failed",
        source: "project.ssl-issue",
        projectId: id,
        projectName: `${project.name} (${domainRow.domain})`,
        domainId,
        message: `${project.name}: nginx HTTP route failed before certificate issuance.`,
        output: preApply.output,
      });
      auditLog(user, "project.ssl-issue", `${project.name}:${domainRow.domain}`, "fail");
      return { ok: false, output: preApply.output };
    }

    const cert = await runCertbotAction(domainRow.domain, "issue");
    if (!cert.ok) {
      emitNginxFlow({
        id: flowId,
        status: "failed",
        source: "project.ssl-issue",
        projectId: id,
        projectName: `${project.name} (${domainRow.domain})`,
        domainId,
        message: `${project.name}: certificate issuance failed.`,
        output: cert.output,
      });
      auditLog(user, "project.ssl-issue", `${project.name}:${domainRow.domain}`, "fail");
      return { ok: false, output: cert.output };
    }

    setProjectDomainSsl(id, domainId, true);
    const sslApply = await writeNginxConfig();
    const output = [cert.output, "", "$ nginx apply", sslApply.output || (sslApply.ok ? "ok" : "failed")].filter(Boolean).join("\n");
    emitNginxFlow({
      id: flowId,
      status: sslApply.ok ? "success" : "failed",
      source: "project.ssl-issue",
      projectId: id,
      projectName: `${project.name} (${domainRow.domain})`,
      domainId,
      message: sslApply.ok ? `${project.name}: SSL route is live for ${domainRow.domain}.` : `${project.name}: certificate issued but nginx SSL apply failed.`,
      output,
    });

    auditLog(user, "project.ssl-issue", `${project.name}:${domainRow.domain}`, sslApply.ok ? "ok" : "fail");
    return { ok: sslApply.ok, output };
  });
  if (!started) { respondActionBusy(res, key, "An SSL action is already running for this domain"); return; }
  respondActionStarted(res, started);
});

router.post("/:id/stop", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!getProjectById(id)) { res.status(404).json({ error: "Project not found" }); return; }

  const user = req.user ?? "unknown";
  const key = projectRepoKey(id);
  const started = actionRegistry.tryStart(key, "stop", { projectId: id }, async () => {
    const result = await stopProject(id);
    auditLog(user, "project.stop", String(id), result.ok ? "ok" : "fail", {
      repoPath: result.repoPath,
    });
    return { ok: result.ok, output: result.output };
  });
  if (!started) { respondActionBusy(res, key, "An action is already running for this project"); return; }
  respondActionStarted(res, started);
});

router.get("/:id/logs", requireAuth, async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!getProjectById(id)) { res.status(404).json({ error: "Project not found" }); return; }

  const tail = Math.min(Math.max(parseInt(String(req.query["tail"] ?? "100"), 10) || 100, 10), 1000);
  const service = typeof req.query["service"] === "string" && req.query["service"].trim()
    ? req.query["service"].trim()
    : undefined;

  try {
    const result = await getProjectLogs(id, tail, service);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to fetch logs" });
  }
});

router.post("/:id/stop-purge", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!getProjectById(id)) { res.status(404).json({ error: "Project not found" }); return; }

  const user = req.user ?? "unknown";
  const key = projectRepoKey(id);
  const started = actionRegistry.tryStart(key, "stop-purge", { projectId: id }, async () => {
    const result = await stopAndPurgeProject(id);
    // Deleting the project's data includes its stored action logs (not this run's).
    if (result.ok) deleteProjectActionLogs(id);
    auditLog(user, "project.stop-purge", String(id), result.ok ? "ok" : "fail", {
      repoPath: result.repoPath,
    });
    return { ok: result.ok, output: result.output };
  });
  if (!started) { respondActionBusy(res, key, "An action is already running for this project"); return; }
  respondActionStarted(res, started);
});

router.get("/:id/compose-file/content", requireAuth, async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!getProjectById(id)) { res.status(404).json({ error: "Project not found" }); return; }

  const content = await getProjectComposeFileContent(id);
  if (!content) { res.status(404).json({ error: "No compose file found for this project" }); return; }
  res.json(content);
});

router.patch("/:id/compose-file", requireAuth, async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const project = getProjectById(id);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { composeFile } = req.body as Record<string, unknown>;
  if (typeof composeFile !== "string" || !composeFile) {
    res.status(400).json({ error: "composeFile is required" });
    return;
  }

  const repoPath = projectRepoDir(project);
  const candidates = await scanComposeFiles(repoPath);
  const validated = validateComposeFileChoice(composeFile, candidates);
  if (!validated) {
    res.status(400).json({ error: `composeFile must be one of the compose files found at the repo root: ${candidates.join(", ") || "(none found)"}` });
    return;
  }

  const now = new Date().toISOString();
  getDatabase().prepare("UPDATE projects SET compose_file = ?, updated_at = ? WHERE id = ?").run(validated, now, id);
  auditLog(req.user ?? "unknown", "project.compose-file", project.name, "ok", { composeFile: validated });
  res.json(getProjectById(id));
});

router.put("/:id/deploy-trigger", requireAuth, async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const project = getProjectById(id);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const { trigger } = req.body as Record<string, unknown>;
  if (!(DEPLOY_TRIGGERS as readonly unknown[]).includes(trigger)) {
    res.status(400).json({ error: `trigger must be one of: ${DEPLOY_TRIGGERS.join(", ")}` });
    return;
  }
  const next = trigger as DeployTrigger;

  if (next === "webhook") {
    try {
      const result = await enableWebhook(id);
      auditLog(req.user ?? "unknown", "project.deploy-trigger", project.name, "ok", { trigger: next, installedOnGithub: result.installedOnGithub });
      res.json({ project: getProjectById(id), installError: result.installError });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  let warning: string | null = null;
  if (project.webhook) warning = await disableWebhook(id);
  getDatabase().prepare("UPDATE projects SET deploy_trigger = ?, updated_at = ? WHERE id = ?").run(next, new Date().toISOString(), id);
  if (next === "manual") clearPendingAutoDeploy(id);
  auditLog(req.user ?? "unknown", "project.deploy-trigger", project.name, "ok", { trigger: next });
  const updated = getProjectById(id);
  if (updated) emitProjectDataUpdate(id, updated);
  res.json({ project: updated, warning });
});

router.get("/:id/webhook", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!getProjectById(id)) { res.status(404).json({ error: "Project not found" }); return; }
  const base = webhookBaseUrl();
  res.json({ available: base.url !== null, unavailableReason: base.reason, details: getWebhookDetails(id) });
});

router.post("/:id/webhook/ping", requireAuth, async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    await pingWebhook(id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/:id/webhook/reinstall", requireAuth, async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const project = getProjectById(id);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  try {
    const result = await reinstallWebhook(id);
    auditLog(req.user ?? "unknown", "project.webhook.reinstall", project.name, result.installedOnGithub ? "ok" : "fail");
    res.json({ project: getProjectById(id), installError: result.installError });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get("/:id/actions", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!getProjectById(id)) { res.status(404).json({ error: "Project not found" }); return; }

  res.json({
    repo: actionRegistry.get(projectRepoKey(id)) ?? null,
    ssl: actionRegistry.list(projectSslKeyPrefix(id)),
  });
});

// Only the long-running docker/git flows are safe to interrupt with SIGTERM — nginx
// apply, certbot, and stop/stop-purge are excluded on purpose (see actionRegistry).
const CANCELABLE_ACTION_KINDS = new Set(["build", "deploy", "pull", "compose", "recreate", "force-rebuild", "redeploy-service"]);

router.post("/:id/actions/cancel", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!getProjectById(id)) { res.status(404).json({ error: "Project not found" }); return; }

  const key = projectRepoKey(id);
  const record = actionRegistry.get(key);
  if (!record || record.status !== "running" || !CANCELABLE_ACTION_KINDS.has(record.kind)) {
    res.status(409).json({ ok: false, error: "No cancelable action is running for this project" });
    return;
  }

  const cancelled = actionRegistry.cancel(key);
  auditLog(req.user ?? "unknown", "project.action-cancel", String(id), cancelled ? "ok" : "fail", { kind: record.kind });
  res.json({ ok: cancelled });
});

router.post("/", requireAuth, (req: Request, res: Response): void => {
  let project;
  try {
    project = adminCreateProject(req.body as Record<string, unknown>);
  } catch (err) {
    if (err instanceof ProjectAdminError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    throw err;
  }

  healthChecker.schedule(project);
  auditLog(req.user ?? "unknown", "project.create", project.name, "ok");
  res.status(201).json(project);
  void runProjectNginxFlow("project.create", project);
});

router.get("/:id/branches", requireAuth, async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const db = getDatabase();
  const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
  if (!row) { res.status(404).json({ error: "Project not found" }); return; }
  if (!row.github_repo) { res.status(400).json({ error: "Project has no GitHub repo configured" }); return; }

  const project = rowToProject(row);
  try {
    const refresh = req.query["refresh"] === "1" || req.query["refresh"] === "true";
    const branches = await getProjectBranches(project, { refresh });

    let autoDeployBranch = project.autoDeployBranch;
    if (!autoDeployBranch && branches.length > 0) {
      const names = branches.map((branch) => branch.name);
      autoDeployBranch = names.includes("main") ? "main" : names.includes("master") ? "master" : names[0];
      db.prepare("UPDATE projects SET auto_deploy_branch = ?, updated_at = ? WHERE id = ?")
        .run(autoDeployBranch, new Date().toISOString(), id);
    }

    const fetchedRow = db.prepare("SELECT branches_fetched_at FROM projects WHERE id = ?").get(id) as { branches_fetched_at: string | null } | undefined;
    res.json({ branches, autoDeployBranch, fetchedAt: fetchedRow?.branches_fetched_at ?? null });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: `GitHub API error: ${msg}` });
  }
});

interface DeployActionRow {
  id: string;
  project_id: number;
  kind: string;
  commit_sha: string | null;
  commit_message: string | null;
  commit_author: string | null;
  branch: string | null;
  triggered_by: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  log_path: string | null;
}

/** Recent deploy-type actions (manual, auto, webhook, rollback, ...) from the actions log. */
router.get("/:id/deploys", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const db = getDatabase();
  if (!db.prepare("SELECT id FROM projects WHERE id = ?").get(id)) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const rows = db.prepare(
    `SELECT * FROM actions WHERE project_id = ? AND kind IN (${DEPLOY_KINDS_SQL}) ORDER BY started_at DESC LIMIT 50`
  ).all(id) as DeployActionRow[];
  res.json(rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    kind: r.kind,
    commitSha: r.commit_sha,
    commitMessage: r.commit_message,
    commitAuthor: r.commit_author,
    branch: r.branch,
    triggeredBy: r.triggered_by,
    status: r.status,
    createdAt: r.started_at,
    completedAt: r.finished_at,
    hasLog: r.log_path !== null,
  })));
});

/** Deletes every stored action log for the project (Clear logs). Action history stays. */
router.delete("/:id/action-logs", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const project = getProjectById(id);
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const deleted = deleteProjectActionLogs(id);
  auditLog(req.user ?? "unknown", "project.clear-action-logs", project.name, "ok", { deleted });
  res.json({ deleted });
});

router.patch("/:id", requireAuth, async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  let result;
  try { result = updateProject(id, req.body as Record<string, unknown>, { compatibility: "http" }); }
  catch (error) {
    if (error instanceof ProjectAdminError) { res.status(error.statusCode).json({ error: error.message }); return; }
    throw error;
  }
  const { project, nginxFieldsChanged } = result;
  healthChecker.schedule(project);
  auditLog(req.user ?? "unknown", "project.update", project.name, "ok");
  res.json(project);
  if (nginxFieldsChanged) void runProjectNginxFlow("project.update", project);
});

router.delete("/:id", requireAuth, async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const db = getDatabase();
  const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
  if (!row) { res.status(404).json({ error: "Project not found" }); return; }

  await leaveNetworkGroup({ id, name: row.name }).catch(() => undefined);
  try {
    await removeProjectTcpRuntime(id);
  } catch (err) {
    res.status(502).json({ error: `Could not remove project TCP proxies: ${err instanceof Error ? err.message : String(err)}` });
    return;
  }
  if (row.github_hook_id != null) {
    const warning = await disableWebhook(id);
    if (warning) console.warn(`[webhooks] ${row.name}: ${warning}`);
  }
  // Action rows go with the project (ON DELETE CASCADE); their log files don't.
  deleteProjectActionLogs(id);
  db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  healthChecker.unschedule(id);
  void removeIngressNetwork(id);

  auditLog(req.user ?? "unknown", "project.delete", row.name, "ok");
  res.status(204).send();
  void runProjectNginxFlow("project.delete", { id, name: row.name });
});

router.post("/:id/pause", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  setProjectPaused(req, res, true);
});

router.post("/:id/resume", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  setProjectPaused(req, res, false);
});

router.post("/:id/favorite", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  setProjectFavorite(req, res, true);
});

router.post("/:id/unfavorite", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  setProjectFavorite(req, res, false);
});

function setProjectFavorite(req: Request<{ id: string }>, res: Response, favorite: boolean): void {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const db = getDatabase();
  const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
  if (!row) { res.status(404).json({ error: "Project not found" }); return; }

  db.prepare("UPDATE projects SET favorite = ?, updated_at = ? WHERE id = ?")
    .run(favorite ? 1 : 0, new Date().toISOString(), id);
  const updated = rowToProject(db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow);
  auditLog(req.user ?? "unknown", favorite ? "project.favorite" : "project.unfavorite", row.name, "ok");
  res.json(updated);
}

router.post("/:id/check", requireAuth, async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const db = getDatabase();
  const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
  if (!row) { res.status(404).json({ error: "Project not found" }); return; }
  if (row.paused) { res.status(409).json({ error: "Project is paused" }); return; }
  if (!row.health_check_endpoint) { res.status(400).json({ error: "No health check endpoint configured" }); return; }

  await healthChecker.check(id);
  const updated = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow;
  res.json(rowToProject(updated));
});

function setProjectPaused(req: Request<{ id: string }>, res: Response, paused: boolean): void {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  let project;
  try { project = pauseProject(id, paused); }
  catch (error) {
    if (error instanceof ProjectAdminError) { res.status(error.statusCode).json({ error: error.message }); return; }
    throw error;
  }
  if (paused) {
    healthChecker.unschedule(id);
    clearPendingAutoDeploy(id);
  } else {
    healthChecker.schedule(project);
    healthChecker.check(id).catch(console.error);
  }
  auditLog(req.user ?? "unknown", paused ? "project.pause" : "project.resume", project.name, "ok");
  res.json(project);
  void runProjectNginxFlow(paused ? "project.pause" : "project.resume", project);
}

export default router;
