import path from "path";
import * as fs from "fs/promises";
import { Router, Request, Response } from "express";
import { execFile } from "child_process";
import { getDatabase } from "../config/database";
import { requireAuth } from "../middleware/auth";
import { auditLog } from "../utils/logger";
import { decryptSecret } from "../utils/crypto";
import { emitGlobalEvent } from "../services/realtime";
import {
  getNginxLayerStatus,
  getNginxRuntime,
  readNginxDocument,
  reloadNginx,
  setNginxAppConfig,
  writeNginxConfig,
  writeNginxTemplate,
  type NginxDocumentKind,
} from "../services/nginx/configWriter";
import {
  getCertbotStatus,
  runCertbotAction,
  setCertbotEmail,
  type CertbotAction,
} from "../services/certbot";
import { actionRegistry, certbotKey, dockerPruneKey, nginxKey, respondActionBusy, respondActionStarted } from "../services/actionRegistry";
import {
  getComposeStacksCached,
  getContainerListCached,
  getContainerStatsCached,
  getDiskUsageCached,
  getDockerVersionCached,
  invalidateContainers,
  invalidateDiskUsage,
  pruneBuildCache,
} from "../services/dockerStatusCache";
import { getNginxActiveStatusCached, getNginxVersionCached } from "../services/nginx/statusCache";
import { isSystemComposeProject } from "../services/systemResources";
import { getStorageState, getStorageThresholds, setStorageThresholds, type StorageThresholds } from "../services/dockerStorage";

import { startSelfUpdate, getSelfUpdateStatus, SelfUpdateBusyError } from "../services/selfUpdate";

const router = Router();

function emitNginxGlobal(status: "started" | "success" | "failed", id: string, message: string, output?: string): void {
  emitGlobalEvent({
    id,
    type: "nginx:flow",
    status,
    title: status === "started" ? "Applying nginx config" : status === "success" ? "Nginx config applied" : "Nginx config failed",
    message,
    output,
    createdAt: new Date().toISOString(),
  });
}

function emitDockerGlobal(status: "started" | "success" | "failed", id: string, message: string, output?: string): void {
  emitGlobalEvent({
    id,
    type: "docker:flow",
    status,
    title: status === "started" ? "Pruning docker build cache" : status === "success" ? "Docker build cache pruned" : "Docker prune failed",
    message,
    output,
    createdAt: new Date().toISOString(),
  });
}

// ── Shell helper ─────────────────────────────────────────────────────────────

interface RunResult {
  stdout: string;
  stderr: string;
  ok: boolean;
  notFound: boolean;
}

interface BuildInfo {
  name: string;
  version: string;
  builtAt: string | null;
  gitCommit: string;
  gitBranch: string;
  gitMessage: string;
}

interface AppVersionInfo {
  backend: BuildInfo;
  frontend: BuildInfo;
}

interface AppUpdateCheck {
  ok: boolean;
  repo: string | null;
  branch: string | null;
  localCommit: string | null;
  remoteCommit: string | null;
  hasUpdate: boolean;
  output: string;
}

function run(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<RunResult> {
  const { timeoutMs = 12_000, cwd, env } = opts;
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, cwd, env }, (err, stdout, stderr) => {
      const notFound = !!(err && (err as NodeJS.ErrnoException).code === "ENOENT");
      resolve({ stdout, stderr, ok: !err, notFound });
    });
  });
}

export function privileged(cmd: string, args: string[]): { cmd: string; args: string[] } {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return { cmd, args };
  }
  return { cmd: "sudo", args: ["-n", cmd, ...args] };
}


async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

async function readBuildInfo(rootDir: string): Promise<BuildInfo> {
  const [buildInfo, pkg] = await Promise.all([
    readJson<Partial<BuildInfo>>(path.join(rootDir, "build-info.json")),
    readJson<{ name?: string; version?: string }>(path.join(rootDir, "package.json")),
  ]);

  return {
    name: buildInfo?.name ?? pkg?.name ?? path.basename(rootDir),
    version: buildInfo?.version ?? pkg?.version ?? "0.0.0",
    builtAt: buildInfo?.builtAt ?? null,
    gitCommit: buildInfo?.gitCommit ?? "",
    gitBranch: buildInfo?.gitBranch ?? "",
    gitMessage: buildInfo?.gitMessage ?? "",
  };
}

async function getAppVersionInfo(): Promise<AppVersionInfo> {
  const appRoot = path.resolve(__dirname, "..");
  const repoRoot = path.resolve(appRoot, "..");
  const sourceRoot = path.basename(appRoot) === "dist" ? repoRoot : process.cwd();
  const clientRoot = path.join(sourceRoot, "client");
  const [backend, frontend] = await Promise.all([
    readBuildInfo(sourceRoot),
    readBuildInfo(clientRoot),
  ]);
  return { backend, frontend };
}

// ── Self-update git credentials ───────────────────────────────────────────────

const APP_UPDATE_CREDENTIAL_KEY = "app_update_credential_id";

function getAppUpdateCredentialId(): number | null {
  const row = getDatabase().prepare("SELECT value FROM app_meta WHERE key = ?").get(APP_UPDATE_CREDENTIAL_KEY) as { value: string } | undefined;
  const id = row ? Number(row.value) : NaN;
  return Number.isInteger(id) ? id : null;
}

function setAppUpdateCredentialId(id: number | null): void {
  if (id == null) {
    getDatabase().prepare("DELETE FROM app_meta WHERE key = ?").run(APP_UPDATE_CREDENTIAL_KEY);
  } else {
    getDatabase()
      .prepare(`
        INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
      `)
      .run(APP_UPDATE_CREDENTIAL_KEY, String(id));
  }
}

function gitCredentialHeader(credentialId: number | null): string | null {
  if (credentialId == null) return null;
  const row = getDatabase()
    .prepare("SELECT username, secret_enc FROM credentials WHERE id = ? AND type = 'github'")
    .get(credentialId) as { username: string | null; secret_enc: string } | undefined;
  if (!row) return null;
  try {
    const username = row.username ?? "x-access-token";
    const token = decryptSecret(row.secret_enc);
    return `Authorization: Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`;
  } catch {
    return null;
  }
}

function appRepoUrl(repo: string): string {
  if (/^https?:\/\//.test(repo) || repo.startsWith("git@")) return repo;
  return `https://github.com/${repo}.git`;
}

async function getConfiguredAppRepo(): Promise<string | null> {
  const envRepo = process.env["APP_GITHUB_REPO"] ?? process.env["GITHUB_REPO"];
  if (envRepo) return appRepoUrl(envRepo);
  const result = await run("git", ["remote", "get-url", "origin"], { cwd: process.cwd() });
  const repo = result.stdout.trim();
  return result.ok && repo ? repo : null;
}

async function getConfiguredAppBranch(version?: AppVersionInfo): Promise<string | null> {
  if (process.env["GIT_BRANCH"]) return process.env["GIT_BRANCH"];
  const result = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: process.cwd() });
  const branch = result.stdout.trim();
  if (result.ok && branch && branch !== "HEAD") return branch;
  return version?.backend.gitBranch || version?.frontend.gitBranch || "main";
}

async function checkAppUpdate(): Promise<AppUpdateCheck> {
  const version = await getAppVersionInfo();
  const repo = await getConfiguredAppRepo();
  const branch = await getConfiguredAppBranch(version);
  if (!repo || !branch) {
    return { ok: false, repo, branch, localCommit: null, remoteCommit: null, hasUpdate: false, output: "App git repository or branch is not configured." };
  }

  const localGit = await run("git", ["rev-parse", "HEAD"], { cwd: process.cwd() });
  const localCommit = localGit.ok && localGit.stdout.trim()
    ? localGit.stdout.trim()
    : version.backend.gitCommit || version.frontend.gitCommit || null;
  const authHeader = gitCredentialHeader(getAppUpdateCredentialId());
  const args = [
    ...(authHeader ? ["-c", `http.extraHeader=${authHeader}`] : []),
    "ls-remote",
    repo,
    `refs/heads/${branch}`,
  ];
  const remote = await run("git", args, { timeoutMs: 60_000, cwd: process.cwd() });
  const output = [remote.stdout, remote.stderr].filter(Boolean).join("\n").trim();
  if (!remote.ok) {
    return { ok: false, repo, branch, localCommit, remoteCommit: null, hasUpdate: false, output: output || "Failed to query remote commit." };
  }

  const remoteCommit = remote.stdout.trim().split(/\s+/)[0] || null;
  const localComparable = localCommit ?? "";
  const remoteComparable = remoteCommit ?? "";
  const sameCommit = !!localComparable && !!remoteComparable && (
    localComparable === remoteComparable ||
    remoteComparable.startsWith(localComparable) ||
    localComparable.startsWith(remoteComparable)
  );

  return {
    ok: !!remoteCommit,
    repo,
    branch,
    localCommit,
    remoteCommit,
    hasUpdate: !!remoteCommit && !sameCommit,
    output: output || (remoteCommit ? "Remote commit found." : "Branch not found on remote."),
  };
}

function parseNdjson(s: string): Record<string, unknown>[] {
  return s
    .trim()
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try { return [JSON.parse(line) as Record<string, unknown>]; }
      catch { return []; }
    });
}

// "key1=val1,key2=val2=with=equals" → { key1: "val1", key2: "val2=with=equals" }
function parseLabels(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!s) return out;
  for (const kv of s.split(",")) {
    const eq = kv.indexOf("=");
    if (eq > 0) out[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  return out;
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

// ── Docker ───────────────────────────────────────────────────────────────────

async function getDockerData() {
  const versionRes = await getDockerVersionCached();

  const unavailableStorage = { state: "unknown" as const, freeBytes: null, totalBytes: null, freePct: null, thresholds: getStorageThresholds() };
  if (versionRes.notFound) return { available: false, reason: "docker not installed", stacks: [], standalone: [], diskUsage: [], storage: unavailableStorage };
  if (!versionRes.ok)      return { available: false, reason: "Docker daemon not running", stacks: [], standalone: [], diskUsage: [], storage: unavailableStorage };

  let version = "unknown";
  try {
    const v = JSON.parse(versionRes.stdout) as Record<string, Record<string, string>>;
    version = v?.Client?.Version ?? v?.Server?.Version ?? "unknown";
  } catch { /* ignore */ }

  // Each of these is its own single-flighted, TTL'd cache (see dockerStatusCache.ts)
  // shared with the independent project-resource sampler — a poll tick here only
  // spawns a fresh subprocess when that particular cache has actually gone stale.
  const [psRes, statsRes, composeRes, dfRes] = await Promise.all([
    getContainerListCached(),
    getContainerStatsCached(),
    getComposeStacksCached(),
    getDiskUsageCached(),
  ]);

  const diskUsage = parseNdjson(dfRes.stdout).map((entry) => ({
    type:        String(entry.Type ?? ""),
    totalCount:  String(entry.TotalCount ?? "0"),
    active:      String(entry.Active ?? "0"),
    size:        String(entry.Size ?? "—"),
    reclaimable: String(entry.Reclaimable ?? "—"),
  }));

  // Stats map keyed by short container ID
  const statsMap: Record<string, { cpu: string; mem: string; memPerc: string; netIO: string; blockIO: string }> = {};
  parseNdjson(statsRes.stdout).forEach((s) => {
    const id = String(s.ID ?? "").slice(0, 12);
    statsMap[id] = {
      cpu:     String(s.CPUPerc ?? "—"),
      mem:     String(s.MemUsage ?? "—"),
      memPerc: String(s.MemPerc ?? "—"),
      netIO:   String(s.NetIO ?? "—"),
      blockIO: String(s.BlockIO ?? "—"),
    };
  });

  // Parse containers and annotate with compose labels
  interface ContainerEntry {
    id: string;
    name: string;
    service: string | null;
    image: string;
    state: string;
    status: string;
    ports: string;
    composeProject: string | null;
    stats: typeof statsMap[string] | null;
  }

  const allContainers: ContainerEntry[] = parseNdjson(psRes.stdout).map((c) => {
    const id = String(c.ID ?? "").slice(0, 12);
    const labels = parseLabels(String(c.Labels ?? ""));
    return {
      id,
      name:           String(c.Names ?? ""),
      service:        labels["com.docker.compose.service"] ?? null,
      image:          String(c.Image ?? ""),
      state:          String(c.State ?? ""),
      status:         String(c.Status ?? ""),
      ports:          String(c.Ports ?? ""),
      composeProject: labels["com.docker.compose.project"] ?? null,
      stats:          statsMap[id] ?? null,
    };
  });

  // Parse compose stacks
  interface StackMeta { name: string; status: string; configFiles: string[] }
  const stackMeta: StackMeta[] = [];
  if (composeRes.ok) {
    try {
      const parsed = JSON.parse(composeRes.stdout);
      if (Array.isArray(parsed)) {
        for (const s of parsed as Array<Record<string, string>>) {
          stackMeta.push({
            name:        String(s.Name ?? ""),
            status:      String(s.Status ?? ""),
            configFiles: String(s.ConfigFiles ?? "").split(",").map((f) => f.trim()).filter(Boolean),
          });
        }
      }
    } catch { /* ignore */ }
  }

  // Group containers by compose project
  const byProject: Record<string, ContainerEntry[]> = {};
  const standalone: ContainerEntry[] = [];

  for (const c of allContainers) {
    if (c.composeProject) {
      (byProject[c.composeProject] ??= []).push(c);
    } else {
      standalone.push(c);
    }
  }

  // Merge stack metadata with containers
  // Include stacks from `compose ls` even if they have no containers right now
  const knownProjects = new Set(stackMeta.map((s) => s.name));
  // Also add projects seen in container labels that aren't in compose ls
  for (const proj of Object.keys(byProject)) {
    if (!knownProjects.has(proj)) {
      stackMeta.push({ name: proj, status: "unknown", configFiles: [] });
      knownProjects.add(proj);
    }
  }

  const stacks = stackMeta.map((s) => ({
    name:        s.name,
    status:      s.status,
    configFiles: s.configFiles,
    containers:  (byProject[s.name] ?? []).map(({ composeProject: _cp, ...rest }) => rest),
  }));

  const storage = await getStorageState();

  return {
    available: true,
    version,
    stacks,
    standalone: standalone.map(({ composeProject: _cp, ...rest }) => rest),
    diskUsage,
    storage,
  };
}

// ── Nginx ────────────────────────────────────────────────────────────────────

async function getNginxData() {
  const layer = await getNginxLayerStatus();

  const versionRes = await getNginxVersionCached();
  if (!versionRes.ok) {
    return { available: false, reason: (versionRes.stderr || "Nginx container unavailable").trim(), layer };
  }

  const activeRes = await getNginxActiveStatusCached();

  const versionLine = (versionRes.stderr || versionRes.stdout).trim();
  const version = versionLine.replace("nginx version: ", "");
  const active = activeRes.ok && ["active", "true"].includes(activeRes.stdout.trim());
  // `nginx -t` only ever runs as part of an actual config apply (writeNginxConfig) —
  // routine status here reads the persisted result of the last real apply instead of
  // re-validating on every poll.
  const configTest = layer.lastOperation
    ? { ok: layer.lastOperation.ok, output: layer.lastOperation.output }
    : { ok: false, output: "No nginx config has been applied yet." };

  return { available: true, version, active, configTest, layer };
}

const STACK_RE = /^[a-z0-9][a-z0-9_-]*$/i;

async function resolveStack(name: string): Promise<{ configFiles: string[]; cwd: string } | null> {
  const res = await run("docker", ["compose", "ls", "--all", "--format", "json"]);
  if (!res.ok) return null;
  try {
    const list = JSON.parse(res.stdout);
    if (!Array.isArray(list)) return null;
    const entry = (list as Array<Record<string, string>>).find((s) => s.Name === name);
    if (!entry) return null;
    const configFiles = String(entry.ConfigFiles ?? "").split(",").map((f) => f.trim()).filter(Boolean);
    const cwd = configFiles.length > 0 ? path.dirname(configFiles[0]) : process.cwd();
    return { configFiles, cwd };
  } catch { return null; }
}

function composeFileArgs(configFiles: string[]): string[] {
  return configFiles.flatMap((f) => ["-f", f]);
}

function parseNginxDocumentKind(kind: string): NginxDocumentKind | null {
  if (kind === "generated" || kind === "general" || kind === "project" || kind === "failed") return kind;
  if (kind === "fixed") return "general";
  if (kind === "domain") return "project";
  return null;
}

function parseCertbotAction(action: string): CertbotAction | null {
  if (action === "issue" || action === "renew" || action === "delete") return action;
  return null;
}

// ── Routes ───────────────────────────────────────────────────────────────────

router.get("/", requireAuth, async (_req: Request, res: Response): Promise<void> => {
  res.json(await getSystemSnapshot());
});

router.get("/version", requireAuth, async (_req: Request, res: Response): Promise<void> => {
  res.json(await getAppVersionInfo());
});

router.get("/update-config", requireAuth, (_req: Request, res: Response): void => {
  res.json({ credentialId: getAppUpdateCredentialId() });
});

router.put("/update-config", requireAuth, (req: Request, res: Response): void => {
  const { credentialId } = req.body as { credentialId?: number | string | null };
  if (credentialId == null || credentialId === "") {
    setAppUpdateCredentialId(null);
    res.json({ credentialId: null });
    return;
  }
  const id = Number(credentialId);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid credentialId" }); return; }
  const exists = getDatabase().prepare("SELECT id FROM credentials WHERE id = ? AND type = 'github'").get(id);
  if (!exists) { res.status(400).json({ error: "GitHub credential not found" }); return; }
  setAppUpdateCredentialId(id);
  res.json({ credentialId: id });
});

router.get("/docker/storage-thresholds", requireAuth, (_req: Request, res: Response): void => {
  res.json(getStorageThresholds());
});

router.put("/docker/storage-thresholds", requireAuth, (req: Request, res: Response): void => {
  const { warningFreeBytes, warningFreePct, criticalFreeBytes, criticalFreePct } = req.body as Partial<StorageThresholds>;
  const values = { warningFreeBytes, warningFreePct, criticalFreeBytes, criticalFreePct };
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      res.status(400).json({ error: `${key} must be a non-negative number` });
      return;
    }
  }
  const thresholds = values as StorageThresholds;
  setStorageThresholds(thresholds);
  auditLog(req.user ?? "unknown", "system.docker-storage-thresholds", "app_meta", "ok", { ...thresholds });
  res.json(thresholds);
});

router.get("/nginx/runtime", requireAuth, (_req: Request, res: Response): void => {
  res.json({ runtime: getNginxRuntime() });
});

router.get("/update/status", requireAuth, async (_req: Request, res: Response): Promise<void> => {
  try { res.json(await getSelfUpdateStatus()); }
  catch { res.status(503).json({error: "Cannot read the Stackport updater status."}); }
});

router.post("/update", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await startSelfUpdate();
    auditLog(req.user ?? "unknown", "system.self-update-start", "stackport", "ok", {id: result.id});
    res.json(result);
  } catch (error) {
    const busy = error instanceof SelfUpdateBusyError;
    if (!busy) console.error("[selfUpdate] launch failed:", error instanceof Error ? error.message : "unknown error");
    res.status(busy ? 409 : 500).json({error: busy ? error.message : "Cannot start the Stackport updater. Check Docker access and the installed host CLI."});
  }
});

router.get("/update/check", requireAuth, async (_req: Request, res: Response): Promise<void> => {
  res.json(await checkAppUpdate());
});

router.post("/nginx/reload", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await reloadNginx();
    auditLog(req.user ?? "unknown", "system.nginx-reload", "nginx", result.ok ? "ok" : "fail");
    res.json({ ok: result.ok, output: result.output });
  } catch (err) {
    auditLog(req.user ?? "unknown", "system.nginx-reload", "nginx", "fail");
    res.status(500).json({ ok: false, output: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/nginx/apply", requireAuth, (req: Request, res: Response): void => {
  const user = req.user ?? "unknown";
  const key = nginxKey();
  const started = actionRegistry.tryStart(key, "nginx-apply", {}, async () => {
    const flowId = `system.nginx-apply:${Date.now()}`;
    emitNginxGlobal("started", flowId, "Manual nginx apply started.");
    try {
      const result = await writeNginxConfig();
      emitNginxGlobal(result.ok ? "success" : "failed", flowId, result.ok ? "Manual nginx apply completed." : "Manual nginx apply failed.", result.output);
      auditLog(user, "system.nginx-apply", "nginx", result.ok ? "ok" : "fail");
      return { ok: result.ok, output: result.output };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emitNginxGlobal("failed", flowId, "Manual nginx apply failed.", msg);
      auditLog(user, "system.nginx-apply", "nginx", "fail");
      return { ok: false, output: msg };
    }
  });
  if (!started) { respondActionBusy(res, key, "An nginx action is already running"); return; }
  respondActionStarted(res, started);
});

router.put("/nginx/app", requireAuth, (req: Request, res: Response): void => {
  const { enabled, domain, useSsl } = req.body as Record<string, unknown>;
  if (typeof enabled !== "boolean" || typeof domain !== "string") {
    res.status(400).json({ error: "enabled and domain are required" });
    return;
  }

  const user = req.user ?? "unknown";
  let appConfig;
  try {
    appConfig = setNginxAppConfig({ enabled, domain, useSsl: useSsl !== false });
  } catch (err) {
    auditLog(user, "system.nginx-app-config", "stackport", "fail");
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }

  const key = nginxKey();
  const started = actionRegistry.tryStart(key, "nginx-app", { app: appConfig }, async () => {
    const flowId = `system.nginx-app:${Date.now()}`;
    emitNginxGlobal("started", flowId, "StackPort publishing saved. Applying nginx config.");
    try {
      const result = await writeNginxConfig();
      emitNginxGlobal(result.ok ? "success" : "failed", flowId, result.ok ? "StackPort publishing is live." : "StackPort publishing apply failed.", result.output);
      auditLog(user, "system.nginx-app-config", appConfig.domain || "stackport", result.ok ? "ok" : "fail");
      return { ok: result.ok, output: result.output, meta: { app: appConfig } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emitNginxGlobal("failed", flowId, "StackPort publishing apply failed.", msg);
      auditLog(user, "system.nginx-app-config", "stackport", "fail");
      return { ok: false, output: msg, meta: { app: appConfig } };
    }
  });
  if (!started) { respondActionBusy(res, key, "An nginx action is already running"); return; }
  respondActionStarted(res, started);
});

router.get("/nginx/files/:kind", requireAuth, async (req: Request<{ kind: string }>, res: Response): Promise<void> => {
  const kind = parseNginxDocumentKind(req.params.kind);
  if (!kind) {
    res.status(400).json({ error: "kind must be one of: generated, failed, general, project" });
    return;
  }

  res.json(await readNginxDocument(kind));
});

router.put("/nginx/files/:kind", requireAuth, async (req: Request<{ kind: string }>, res: Response): Promise<void> => {
  const kind = parseNginxDocumentKind(req.params.kind);
  if (kind !== "general" && kind !== "project") {
    res.status(400).json({ error: "Only general and project templates are editable" });
    return;
  }

  const { content } = req.body as Record<string, unknown>;
  if (typeof content !== "string") {
    res.status(400).json({ error: "content is required" });
    return;
  }

  const document = await writeNginxTemplate(kind, content);
  auditLog(req.user ?? "unknown", `system.nginx-template-${kind}`, "nginx", "ok");
  res.json(document);
});

router.get("/certbot", requireAuth, async (_req: Request, res: Response): Promise<void> => {
  res.json(await getCertbotStatus());
});

router.put("/certbot/email", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { email } = req.body as Record<string, unknown>;
  if (typeof email !== "string") {
    res.status(400).json({ error: "email is required" });
    return;
  }

  const normalized = email.trim();
  if (normalized && !isValidEmail(normalized)) {
    res.status(400).json({ error: "Enter a valid certbot email address" });
    return;
  }

  const result = setCertbotEmail(normalized);
  auditLog(req.user ?? "unknown", "system.certbot-email", "certbot", "ok");
  res.json(result);
});

router.post("/certbot/:domain/:action", requireAuth, (req: Request<{ domain: string; action: string }>, res: Response): void => {
  const action = parseCertbotAction(req.params.action);
  if (!action) {
    res.status(400).json({ error: "Action must be one of: issue, renew, delete" });
    return;
  }

  const user = req.user ?? "unknown";
  const domain = req.params.domain;
  const key = certbotKey(domain, action);
  const started = actionRegistry.tryStart(key, `certbot-${action}`, { domain, action }, async () => {
    const result = await runCertbotAction(domain, action);
    let output = result.output;
    if (result.ok) {
      const flowId = `system.certbot-${action}:${domain}:${Date.now()}`;
      emitNginxGlobal("started", flowId, `${domain}: certbot ${action} completed. Applying nginx config.`);
      const apply = await writeNginxConfig();
      emitNginxGlobal(
        apply.ok ? "success" : "failed",
        flowId,
        apply.ok ? `${domain}: nginx config applied after certbot ${action}.` : `${domain}: nginx apply failed after certbot ${action}.`,
        apply.output
      );
      output = [
        result.output,
        "",
        "$ nginx apply",
        apply.output || (apply.ok ? "ok" : "failed"),
      ].filter(Boolean).join("\n");
    }
    auditLog(user, `system.certbot-${action}`, domain, result.ok ? "ok" : "fail");
    return { ok: result.ok, output };
  });
  if (!started) { respondActionBusy(res, key, `A certbot ${action} action is already running for ${domain}`); return; }
  respondActionStarted(res, started);
});

router.get("/actions", requireAuth, (_req: Request, res: Response): void => {
  res.json({
    nginx: actionRegistry.get(nginxKey()) ?? null,
    certbot: actionRegistry.list("system:certbot:"),
    docker: actionRegistry.get(dockerPruneKey()) ?? null,
  });
});

// POST /api/system/docker/compose/:name/up|down|build
// The UI action "down" intentionally stops containers instead of removing them.
const COMPOSE_ACTIONS = ["up", "down", "build"] as const;
type ComposeAction = (typeof COMPOSE_ACTIONS)[number];
export const CONTAINER_REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function dockerLogLineCount(value: unknown): number {
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(parsed)) return 200;
  return Math.min(Math.max(parsed, 1), 1000);
}

router.post(
  "/docker/compose/:name/:action",
  requireAuth,
  async (req: Request<{ name: string; action: string }>, res: Response): Promise<void> => {
    const { name, action } = req.params;

    if (!STACK_RE.test(name) || name.length > 64) {
      res.status(400).json({ error: "Invalid stack name" });
      return;
    }
    if (!COMPOSE_ACTIONS.includes(action as ComposeAction)) {
      res.status(400).json({ error: `Action must be one of: ${COMPOSE_ACTIONS.join(", ")}` });
      return;
    }
    if (isSystemComposeProject(name)) {
      res.status(403).json({ error: "StackPort's own infrastructure isn't managed through this route" });
      return;
    }

    const stack = await resolveStack(name);
    if (!stack) {
      res.status(404).json({ error: `Compose stack "${name}" not found` });
      return;
    }

    const fileArgs = composeFileArgs(stack.configFiles);

    let cmdArgs: string[];
    let timeoutMs: number;
    if (action === "up") {
      cmdArgs = ["-p", name, ...fileArgs, "up", "-d"];
      timeoutMs = 120_000;
    } else if (action === "down") {
      // Addressed purely by compose project name (label-based), no -f/config files —
      // stopping existing containers doesn't need the compose file's content at all,
      // and requiring it made this fail outright whenever the file went missing or
      // needed env interpolation that could no longer be satisfied (e.g. a required
      // var with no default and no .env present).
      cmdArgs = ["-p", name, "stop"];
      timeoutMs = 120_000;
    } else {
      // build
      cmdArgs = ["-p", name, ...fileArgs, "build"];
      timeoutMs = 600_000; // 10 min — builds can be slow
    }

    const result = await run("docker", ["compose", ...cmdArgs], { timeoutMs, cwd: stack.cwd });
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    // "up"/"down" change the running container set; a plain "build" doesn't.
    if (action !== "build") invalidateContainers();

    auditLog(req.user ?? "unknown", `system.compose-${action}`, name, result.ok ? "ok" : "fail");
    res.json({ ok: result.ok, output });
  }
);

router.post("/docker/prune", requireAuth, (req: Request, res: Response): void => {
  const user = req.user ?? "unknown";
  const key = dockerPruneKey();
  const started = actionRegistry.tryStart(key, "docker-prune", {}, async () => {
    const flowId = `system.docker-prune:${Date.now()}`;
    emitDockerGlobal("started", flowId, "Pruning docker build cache.");
    try {
      // No age filter: the "Reclaimable" figure shown next to this button comes from
      // `docker system df`, which counts ALL reclaimable build cache regardless of
      // age. A `--filter until=...` here silently excludes anything newer than that,
      // so the button can report 0B reclaimed while the UI still advertises several
      // GB reclaimable — filtering only what's actually prunable keeps the two in sync.
      // Shared with the Phase 1.4 pre-build guard and automatic cleanup monitor —
      // pruneBuildCache() already invalidates the disk-usage/free-space caches.
      const result = await pruneBuildCache();
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      emitDockerGlobal(
        result.ok ? "success" : "failed",
        flowId,
        result.ok ? "Docker build cache pruned." : "Docker build cache prune failed.",
        output
      );
      auditLog(user, "system.docker-prune", "docker", result.ok ? "ok" : "fail");
      return { ok: result.ok, output };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      invalidateDiskUsage();
      emitDockerGlobal("failed", flowId, "Docker build cache prune failed.", msg);
      auditLog(user, "system.docker-prune", "docker", "fail");
      return { ok: false, output: msg };
    }
  });
  if (!started) { respondActionBusy(res, key, "A docker prune is already running"); return; }
  respondActionStarted(res, started);
});

router.get(
  "/docker/containers/:id/logs",
  requireAuth,
  async (req: Request<{ id: string }, unknown, unknown, { lines?: string }>, res: Response): Promise<void> => {
    const { id } = req.params;
    if (!CONTAINER_REF_RE.test(id)) {
      res.status(400).json({ error: "Invalid container id" });
      return;
    }

    const lines = dockerLogLineCount(req.query.lines);
    const result = await run("docker", ["logs", "--timestamps", "--tail", String(lines), id], { timeoutMs: 30_000 });
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();

    auditLog(req.user ?? "unknown", "system.container-logs", id, result.ok ? "ok" : "fail");
    res.json({
      ok: result.ok,
      containerId: id,
      lines,
      output: output || (result.ok ? "(no logs)" : "Failed to read container logs"),
    });
  }
);

export default router;

// ── Exported snapshot for socket manager ─────────────────────────────────────
export async function getSystemSnapshot() {
  const [docker, nginx, certbot, version] = await Promise.allSettled([getDockerData(), getNginxData(), getCertbotStatus(), getAppVersionInfo()]);
  return {
    docker: docker.status === "fulfilled" ? docker.value : { available: false, reason: String(docker.reason) },
    nginx:  nginx.status === "fulfilled"  ? nginx.value  : { available: false, reason: String(nginx.reason) },
    certbot: certbot.status === "fulfilled" ? certbot.value : { available: false, reason: String(certbot.reason), entries: [] },
    version: version.status === "fulfilled" ? version.value : null,
  };
}
