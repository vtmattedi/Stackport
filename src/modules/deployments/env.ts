/* eslint-disable security/detect-non-literal-fs-filename -- all deployment file paths are checked against their checkout or owned by Stackport. */
import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { promisify } from "util";
import { clearEnvRemovals, envFileFingerprint, listProjectEnvFiles, normalizeEnvRelativePath, pendingEnvRemovals, renderEnvFile, type ProjectEnvFile } from "../projects/envFiles";
import type { Project } from "../projects/types";
import { deployRoot } from "../projects/workspace";
import { resolveContainedPath } from "../../shared/safePath";

const git = promisify(execFile);

export async function writeEnvFiles(repoPath: string, envFiles: ProjectEnvFile[]): Promise<string[]> {
  const written: string[] = [];
  for (const envFile of envFiles) {
    const normalized = normalizeEnvRelativePath(envFile.relativePath);
    if (!normalized) throw new Error(`Invalid env path: ${envFile.relativePath}`);
    // Writing an empty .env for values we cannot read would start the project with blank secrets.
    if (envFile.unreadable) throw new Error(`Cannot write ${envFile.relativePath}: its stored values cannot be decrypted with the configured keys. Restore the key (ENCRYPTION_KEY, or the old one as ENCRYPTION_KEY_PREVIOUS) and deploy again.`);
    const target = resolveContainedPath(repoPath, normalized);
    if (!target) {
      throw new Error(`Env path escapes repository: ${envFile.relativePath}`);
    }
    const content = renderEnvFile(envFile.variables);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
    written.push(normalized);
  }
  return written;
}

/** Reconcile previously materialized managed files before running Compose. */
export async function writeDeploymentEnv(project: Project, repoPath: string, envFiles = listProjectEnvFiles(project.id)): Promise<string[]> {
  const journal = path.join(deployRoot(), ".stackport", String(project.id), "env-files.json");
  let previous: string[] = [];
  try {
    const data: unknown = JSON.parse(await fs.readFile(journal, "utf8"));
    if (!Array.isArray(data) || data.some((item) => typeof item !== "string" || normalizeEnvRelativePath(item) !== item)) {
      throw new Error("The deployment's env file inventory is invalid.");
    }
    previous = data as string[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const desired = new Set(envFiles.map((file) => file.relativePath));
  const managed = new Set(previous);
  const pending = pendingEnvRemovals(project.id);
  const paths = new Map(pending.map(({ relativePath, fingerprint }) => [relativePath, fingerprint]));
  for (const relative of managed) paths.set(relative, null);
  const save = async (files: string[]): Promise<void> => {
    await fs.mkdir(path.dirname(journal), { recursive: true });
    await fs.writeFile(journal + ".tmp", JSON.stringify(files), { mode: 0o600 });
    await fs.rename(journal + ".tmp", journal);
  };

  // Include pending writes so a restart partway through leaves enough information to retry.
  await save([...new Set([...previous, ...desired])]);
  for (const [relative, fingerprint] of paths) {
    if (desired.has(relative)) continue;
    if (normalizeEnvRelativePath(relative) !== relative) throw new Error("Invalid path in deployment env cleanup.");
    const target = resolveContainedPath(repoPath, relative);
    if (!target) throw new Error(`Env path escapes repository: ${relative}`);
    const tracked = project.sourceType === "github" && await git("git", ["--literal-pathspecs", "ls-files", "--error-unmatch", "--", relative], { cwd: repoPath, timeout: 15_000 })
      .then(() => true, (err: NodeJS.ErrnoException) => {
        if (Number(err.code) === 1) return false;
        throw err;
      });
    if (tracked) await git("git", ["--literal-pathspecs", "restore", "--source=HEAD", "--worktree", "--", relative], { cwd: repoPath, timeout: 15_000 });
    else if (managed.has(relative) || await matchesLegacyEnvFile(target, fingerprint)) await fs.rm(target, { force: true });
  }
  const written = await writeEnvFiles(repoPath, envFiles);
  await save(written);
  if (pending.length) clearEnvRemovals(pending.map(({ id }) => id));
  return written;
}

async function matchesLegacyEnvFile(target: string, fingerprint: string | null): Promise<boolean> {
  if (!fingerprint) return false;
  const stat = await fs.lstat(target).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (!stat?.isFile() || !fingerprint.startsWith(`${stat.size}:`)) return false;
  return envFileFingerprint(await fs.readFile(target, "utf8")) === fingerprint;
}
