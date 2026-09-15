import { Router, Request, Response, NextFunction } from "express";
import { getDatabase } from "../config/database";
import { requireAuth } from "../middleware/auth";
import { auditLog } from "../utils/logger";
import { rowToProject, type ProjectRow } from "../entities/Project";
import { healthChecker } from "../services/healthChecker";
import { getNginxAppConfig, writeNginxConfig } from "../services/nginx/configWriter";
import { emitGlobalEvent } from "../services/realtime";
import {
  buildProject,
  cleanOrphanFolder,
  composeProject,
  createProjectEnvFile,
  deleteProjectEnvFile,
  deployProject,
  ensureProjectProxyNetwork,
  getProjectById,
  getProjectComposeFileContent,
  getProjectLogs,
  isValidBranchName,
  listProjectEnvFiles,
  normalizeEnvRelativePath,
  parseEnvVariables,
  forceRebuildProject,
  projectRepoDir,
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
  updateProjectEnvFile,
  validateComposeFileChoice,
} from "../services/projectDeploy";
import { getProjectBranches } from "../services/githubPoller";
import { runCertbotAction } from "../services/certbot";
import { actionRegistry, projectRepoKey, projectSslKey, projectSslKeyPrefix, respondActionStarted, respondActionBusy } from "../services/actionRegistry";
import { clampHours, getProjectResourceSnapshot, getProjectResourcesSummary, getProjectResourcesTimeseries, type ResourceMetric } from "./projectResources";
import { createProject as adminCreateProject, ProjectAdminError } from "../services/projectAdmin";
import {
  addProjectDomain,
  attachDomains,
  getFirstProjectDomain,
  getProjectDomain,
  listProjectDomains,
  parseContainerPort,
  parseServiceName,
  ProjectDomainError,
  removeProjectDomain,
  setProjectDomainRoute,
  setProjectDomainSsl,
} from "../services/projectDomains";
import { stageAndApplyUpload } from "../services/projectUpload";
import { listProjectDeployments } from "../services/projectDeployments";
import multer from "multer";

const router = Router();

// Validate "owner/repo" format
const GITHUB_REPO_RE = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

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

// Covers only fields that live on the projects row itself — domain add/remove/ssl
// toggles go through the /:id/domains routes, which trigger their own nginx apply.
function nginxFieldsChanged(existing: ProjectRow, next: { internalPort: number | null; nginxExtraConfig: string | null; nginxExtraBlocks: string | null }): boolean {
  const routed = next.internalPort != null;
  return existing.internal_port !== next.internalPort ||
    (routed && (existing.nginx_extra_config ?? null) !== next.nginxExtraConfig) ||
    (routed && (existing.nginx_extra_blocks ?? null) !== next.nginxExtraBlocks);
}

router.get("/", requireAuth, (_req: Request, res: Response): void => {
  const rows = getDatabase()
    .prepare("SELECT * FROM projects ORDER BY favorite DESC, name ASC")
    .all() as ProjectRow[];
  res.json(attachDomains(rows.map(rowToProject)));
});

/** Snapshot of every project repo/ssl action still running, with project names attached — lets the client resume toasts for actions started before it connected (e.g. a build kicked off from another tab, or one still running across a page reload). */
router.get("/actions/running", requireAuth, (_req: Request, res: Response): void => {
  const rows = getDatabase()
    .prepare("SELECT id, name FROM projects")
    .all() as Pick<ProjectRow, "id" | "name">[];
  const names = new Map(rows.map((row) => [row.id, row.name]));

  const running = actionRegistry
    .list("project:")
    .filter((action) => action.status === "running" && (action.key.endsWith(":repo") || action.key.endsWith(":ssl")))
    .map((action) => ({
      action,
      projectId: action.projectId ?? null,
      projectName: action.projectId != null ? names.get(action.projectId) ?? null : null,
    }));
  res.json(running);
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

  const envFile = updateProjectEnvFile(envId, id, normalizedPath, parsedVariables);
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

  const user = req.user ?? "unknown";
  const key = projectRepoKey(id);
  const started = actionRegistry.tryStart(key, "upload", { projectId: id }, async () => {
    const result = await stageAndApplyUpload(
      id,
      { relativePath: composeFiles[0].originalname, buffer: composeFiles[0].buffer },
      supportFiles.map((file, index) => ({ relativePath: supportPaths[index], buffer: file.buffer })),
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

router.post("/:id/rollback", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!getProjectById(id)) { res.status(404).json({ error: "Project not found" }); return; }

  const user = req.user ?? "unknown";
  const key = projectRepoKey(id);
  const started = actionRegistry.tryStart(key, "rollback", { projectId: id }, async () => {
    const result = await rollbackProject(id);
    auditLog(user, "project.rollback", String(id), result.ok ? "ok" : "fail", { repoPath: result.repoPath });
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

  const user = req.user ?? "unknown";
  const key = projectRepoKey(id);
  const started = actionRegistry.tryStart(key, "deploy", { projectId: id }, async () => {
    const result = await deployProject(id);
    auditLog(user, "project.deploy", String(id), result.ok ? "ok" : "fail", {
      repoPath: result.repoPath,
    });
    return { ok: result.ok, output: result.output };
  });
  if (!started) { respondActionBusy(res, key, "An action is already running for this project"); return; }
  respondActionStarted(res, started);
});

router.get("/:id/domains", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!getProjectById(id)) { res.status(404).json({ error: "Project not found" }); return; }
  res.json(listProjectDomains(id));
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

  return { ok: true, service: parsedService, containerPort: parsedPort };
}

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
  healthChecker.schedule({ ...project, domain: getFirstProjectDomain(id) });
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
  healthChecker.schedule({ ...project, domain: getFirstProjectDomain(id) });
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

  healthChecker.schedule({ ...project, domain: getFirstProjectDomain(project.id) });
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
    const branches = await getProjectBranches(project);

    let autoDeployBranch = project.autoDeployBranch;
    if (!autoDeployBranch && branches.length > 0) {
      const names = branches.map((branch) => branch.name);
      autoDeployBranch = names.includes("main") ? "main" : names.includes("master") ? "master" : names[0];
      db.prepare("UPDATE projects SET auto_deploy_branch = ?, updated_at = ? WHERE id = ?")
        .run(autoDeployBranch, new Date().toISOString(), id);
    }

    res.json({ branches, autoDeployBranch });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: `GitHub API error: ${msg}` });
  }
});

interface ProjectDeployRow {
  id: number;
  project_id: number;
  commit_sha: string | null;
  commit_message: string | null;
  commit_author: string | null;
  triggered_by: string;
  status: string;
  created_at: string;
  completed_at: string | null;
}

router.get("/:id/deploys", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const db = getDatabase();
  if (!db.prepare("SELECT id FROM projects WHERE id = ?").get(id)) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const rows = db.prepare(
    "SELECT * FROM project_deploys WHERE project_id = ? ORDER BY created_at DESC LIMIT 50"
  ).all(id) as ProjectDeployRow[];
  res.json(rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    commitSha: r.commit_sha,
    commitMessage: r.commit_message,
    commitAuthor: r.commit_author,
    triggeredBy: r.triggered_by,
    status: r.status,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  })));
});

router.patch("/:id", requireAuth, async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const db = getDatabase();
  const existing = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
  if (!existing) { res.status(404).json({ error: "Project not found" }); return; }

  const { name, internalPort, healthCheckEndpoint, healthCheckIntervalS, githubRepo, credentialId, githubCredentialId, autoDeployBranch, nginxExtraConfig, nginxExtraBlocks } =
    req.body as Record<string, unknown>;

  const newName = typeof name === "string" && name.trim() ? name.trim().slice(0, 100) : existing.name;
  let newInternalPort = existing.internal_port;
  if (internalPort !== undefined) {
    if (internalPort === null || internalPort === "") {
      newInternalPort = null;
    } else {
      const parsed = parseInternalPort(internalPort);
      if (parsed === null) {
        res.status(400).json({ error: "internalPort must be a TCP port from 1 to 65535" });
        return;
      }
      newInternalPort = parsed;
    }
  }

  let newHcEndpoint = existing.health_check_endpoint;
  if (healthCheckEndpoint !== undefined) {
    if (healthCheckEndpoint === null || healthCheckEndpoint === "") {
      newHcEndpoint = null;
    } else {
      const parsed = parseHealthCheckEndpoint(healthCheckEndpoint);
      if (parsed === null) {
        res.status(400).json({ error: "healthCheckEndpoint must be a relative path like /health" });
        return;
      }
      newHcEndpoint = parsed;
    }
  }
  const newIntervalS = typeof healthCheckIntervalS === "number"
    ? Math.max(0, Math.floor(healthCheckIntervalS))
    : existing.health_check_interval_s;

  let newGhRepo = existing.github_repo;
  if (githubRepo !== undefined) {
    const parsed = parseGithubRepo(githubRepo);
    if (parsed === null && githubRepo !== null && githubRepo !== "") {
      res.status(400).json({ error: "githubRepo must be in 'owner/repo' format or empty to clear" });
      return;
    }
    newGhRepo = parsed;
  }

  let newCredId = existing.credential_id;
  if (credentialId !== undefined) {
    if (credentialId === null) {
      newCredId = null;
    } else {
      const parsed = parseCredentialId(credentialId);
      if (parsed === null) {
        res.status(400).json({ error: "credentialId must be a positive integer or null to clear" });
        return;
      }
      if (!db.prepare("SELECT id FROM credentials WHERE id = ?").get(parsed)) {
        res.status(400).json({ error: "Credential not found" });
        return;
      }
      newCredId = parsed;
    }
  }

  let newGithubCredId = existing.github_credential_id;
  if (githubCredentialId !== undefined) {
    if (githubCredentialId === null) {
      newGithubCredId = null;
    } else {
      const parsed = parseCredentialId(githubCredentialId);
      if (parsed === null) {
        res.status(400).json({ error: "githubCredentialId must be a positive integer or null to clear" });
        return;
      }
      if (!db.prepare("SELECT id FROM credentials WHERE id = ? AND type = 'github'").get(parsed)) {
        res.status(400).json({ error: "GitHub credential not found" });
        return;
      }
      newGithubCredId = parsed;
    }
  }

  let newAutoDeployBranch = existing.auto_deploy_branch ?? null;
  if (autoDeployBranch !== undefined) {
    newAutoDeployBranch = autoDeployBranch === null || autoDeployBranch === ""
      ? null
      : typeof autoDeployBranch === "string" ? autoDeployBranch.trim().slice(0, 255) : existing.auto_deploy_branch ?? null;
  }

  let newNginxExtraConfig = existing.nginx_extra_config ?? null;
  if (nginxExtraConfig !== undefined) {
    if (nginxExtraConfig === null || nginxExtraConfig === "") {
      newNginxExtraConfig = null;
    } else {
      const parsed = parseNginxExtraConfig(nginxExtraConfig);
      if (parsed === null) {
        res.status(400).json({ error: `nginxExtraConfig must be a string of at most ${NGINX_EXTRA_CONFIG_MAX_LENGTH} characters` });
        return;
      }
      newNginxExtraConfig = parsed;
    }
  }

  let newNginxExtraBlocks = existing.nginx_extra_blocks ?? null;
  if (nginxExtraBlocks !== undefined) {
    if (nginxExtraBlocks === null || nginxExtraBlocks === "") {
      newNginxExtraBlocks = null;
    } else {
      const parsed = parseNginxExtraBlocks(nginxExtraBlocks);
      if (parsed === null) {
        res.status(400).json({ error: `nginxExtraBlocks must be a string of at most ${NGINX_EXTRA_BLOCKS_MAX_LENGTH} characters` });
        return;
      }
      newNginxExtraBlocks = parsed;
    }
  }

  const appNginx = getNginxAppConfig();

  if (newInternalPort !== null && db.prepare("SELECT id FROM projects WHERE internal_port = ? AND id <> ?").get(newInternalPort, id)) {
    res.status(409).json({ error: "internalPort is already used by another project" });
    return;
  }
  if (appNginx.enabled && newInternalPort === appNginx.port) {
    res.status(409).json({ error: `internalPort ${appNginx.port} is reserved for StackPort while app Nginx publishing is enabled` });
    return;
  }

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE projects
     SET name = ?, internal_port = ?, health_check_endpoint = ?, health_check_interval_s = ?,
         github_repo = ?, credential_id = ?, github_credential_id = ?,
         auto_deploy_branch = ?, nginx_extra_config = ?, nginx_extra_blocks = ?, updated_at = ?
     WHERE id = ?`
  ).run(newName, newInternalPort, newHcEndpoint, newIntervalS, newGhRepo, newCredId, newGithubCredId, newAutoDeployBranch, newNginxExtraConfig, newNginxExtraBlocks, now, id);

  const updated = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow;
  const project = rowToProject(updated);
  healthChecker.schedule({ ...project, domain: getFirstProjectDomain(id) });
  const shouldRebuildNginx = nginxFieldsChanged(existing, {
    internalPort: newInternalPort,
    nginxExtraConfig: newNginxExtraConfig,
    nginxExtraBlocks: newNginxExtraBlocks,
  });

  auditLog(req.user ?? "unknown", "project.update", project.name, "ok");
  res.json(project);
  if (shouldRebuildNginx) {
    void runProjectNginxFlow("project.update", project);
  }
});

router.delete("/:id", requireAuth, (req: Request<{ id: string }>, res: Response): void => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const db = getDatabase();
  const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
  if (!row) { res.status(404).json({ error: "Project not found" }); return; }

  db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  healthChecker.unschedule(id);

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

  const db = getDatabase();
  const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
  if (!row) { res.status(404).json({ error: "Project not found" }); return; }
  const now = new Date().toISOString();
  db.prepare("UPDATE projects SET paused = ?, last_status = ?, updated_at = ? WHERE id = ?")
    .run(paused ? 1 : 0, paused ? "unknown" : row.last_status, now, id);
  if (paused) {
    healthChecker.unschedule(id);
  } else {
    const resumed = rowToProject(db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow);
    healthChecker.schedule({ ...resumed, domain: getFirstProjectDomain(id) });
    healthChecker.check(id).catch(console.error);
  }
  const updated = rowToProject(db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow);
  auditLog(req.user ?? "unknown", paused ? "project.pause" : "project.resume", row.name, "ok");
  res.json(updated);
  void runProjectNginxFlow(paused ? "project.pause" : "project.resume", updated);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseGithubRepo(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (trimmed === "") return null;
  const normalized = trimmed
    .replace(/^git@github\.com:/i, "")
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/g, "");
  return GITHUB_REPO_RE.test(normalized) ? normalized : null;
}

function parseCredentialId(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseInternalPort(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v.trim()) : NaN;
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
}

function parseHealthCheckEndpoint(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (trimmed === "") return null;
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return null;
  try {
    const parsed = new URL(`https://example.test${trimmed}`);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

const NGINX_EXTRA_CONFIG_MAX_LENGTH = 4000;

function parseNginxExtraConfig(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const normalized = v.replace(/\r\n/g, "\n").trim();
  if (normalized === "" || normalized.length > NGINX_EXTRA_CONFIG_MAX_LENGTH) return null;
  return normalized;
}

const NGINX_EXTRA_BLOCKS_MAX_LENGTH = 8000;

function parseNginxExtraBlocks(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const normalized = v.replace(/\r\n/g, "\n").trim();
  if (normalized === "" || normalized.length > NGINX_EXTRA_BLOCKS_MAX_LENGTH) return null;
  return normalized;
}

export default router;
