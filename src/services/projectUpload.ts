import * as fs from "fs/promises";
import * as path from "path";
import { randomUUID } from "crypto";
import { getDatabase } from "../config/database";
import {
  composeProject,
  deployRoot,
  getProjectById,
  projectRepoDir,
  validateComposeDir,
  type DeployResult,
} from "./projectDeploy";
import { normalizeRelativePath, resolveContainedPath } from "../utils/safePath";
import { emitProjectDeploy } from "./realtime";

export interface UploadFileInput {
  relativePath: string;
  buffer: Buffer;
}

const COMPOSE_FILENAMES = new Set(["docker-compose.yml", "docker-compose.yaml"]);

function stagingRoot(): string {
  return path.join(deployRoot(), ".upload-staging");
}

function failure(projectId: number, repoPath: string, message: string): DeployResult {
  emitProjectDeploy({ projectId, action: "upload", stream: "stderr", message: `${message}\n`, ok: false, done: true });
  return { ok: false, projectId, repoPath, output: message, action: "upload" };
}

/**
 * Stages an uploaded compose file + support files into a scratch directory,
 * dry-run validates them with `docker compose config`, and only then swaps them
 * into the project's real deploy directory (keeping a single backup for
 * rollback). The live directory is never touched if anything above fails.
 */
export async function stageAndApplyUpload(
  projectId: number,
  composeFile: UploadFileInput,
  supportFiles: UploadFileInput[]
): Promise<DeployResult> {
  const project = getProjectById(projectId);
  if (!project) return failure(projectId, "", "Project not found");
  if (project.sourceType !== "upload") return failure(projectId, "", "Project is not configured for manual upload");

  const repoPath = projectRepoDir(project);
  const composeBasename = path.posix.basename(normalizeRelativePath(composeFile.relativePath) ?? "");
  if (!COMPOSE_FILENAMES.has(composeBasename)) {
    return failure(projectId, repoPath, "Compose file must be named docker-compose.yml or docker-compose.yaml");
  }

  const stagingDir = path.join(stagingRoot(), `${projectId}-${randomUUID()}`);
  emitProjectDeploy({ projectId, action: "upload", stream: "status", message: "Staging uploaded files\n" });

  try {
    await fs.mkdir(stagingDir, { recursive: true });

    const composeTarget = resolveContainedPath(stagingDir, composeBasename);
    if (!composeTarget) throw new Error("Compose file path is invalid");
    await fs.writeFile(composeTarget, composeFile.buffer);

    for (const file of supportFiles) {
      const normalized = normalizeRelativePath(file.relativePath);
      if (!normalized) throw new Error(`Invalid support file path: ${file.relativePath}`);
      const target = resolveContainedPath(stagingDir, normalized);
      if (!target) throw new Error(`Support file path escapes upload directory: ${file.relativePath}`);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.buffer);
    }
  } catch (err) {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    return failure(projectId, repoPath, err instanceof Error ? err.message : String(err));
  }

  emitProjectDeploy({ projectId, action: "upload", stream: "status", message: "Validating docker compose file\n" });
  const validation = await validateComposeDir(projectId, stagingDir, composeBasename);
  if (!validation.ok) {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    return failure(projectId, repoPath, validation.output || "docker compose config validation failed");
  }

  const backupDir = `${repoPath}.bak`;
  try {
    const hasExisting = await fs.stat(repoPath).then(() => true).catch(() => false);
    if (hasExisting) {
      await fs.rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
      await fs.rename(repoPath, backupDir);
    }
    await fs.rename(stagingDir, repoPath);
  } catch (err) {
    const stillHasBackup = await fs.stat(backupDir).then(() => true).catch(() => false);
    const liveIsMissing = await fs.stat(repoPath).then(() => false).catch(() => true);
    if (stillHasBackup && liveIsMissing) {
      await fs.rename(backupDir, repoPath).catch(() => undefined);
    }
    return failure(projectId, repoPath, `Failed to apply uploaded files: ${err instanceof Error ? err.message : String(err)}`);
  }

  getDatabase().prepare("UPDATE projects SET compose_file = ?, available_compose_files = ?, updated_at = ? WHERE id = ?")
    .run(composeBasename, JSON.stringify([composeBasename]), new Date().toISOString(), projectId);

  // No `done: true` here — the compose stage below emits its own final
  // done/ok event under action "compose", which is what actually closes out
  // the actionRegistry slot this whole upload+deploy runs under. Marking this
  // intermediate step "done" would finish the slot early and silently drop
  // every subsequent compose-stage log line (actionRegistry.append() is a
  // no-op once status leaves "running").
  emitProjectDeploy({ projectId, action: "upload", stream: "status", message: "Files applied. Starting docker compose.\n" });

  return composeProject(projectId);
}
