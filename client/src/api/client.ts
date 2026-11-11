import type {
  AuditLogQuery,
  RevisionPreview,
  ComposePolicyResult,
  AuditLogResult,
  Project,
  DeployTrigger,
  DeployTriggerResult,
  ProjectWebhookInfo,
  ProjectDomain,
  TcpExposure,
  ComposeEnvFileRef,
  ComposeIngressTarget,
  ActionStartResponse,
  ProjectActionsSnapshot,
  SystemActionsSnapshot,
  ProjectRepoFolderScanResult,
  ProjectEnvFile,
  Credential,
  SystemData,
  ComposeActionResult,
  DockerContainerLogsResult,
  ResourceMetric,
  ProjectResourcesTimeseries,
  SetupStatus,
  SetupLoginResult,
  CertbotEmailConfig,
  NginxDocument,
  NginxDocumentKind,
  SelfUpdateStatus,
  AppUpdateCheck,
  SystemUpdateConfig,
  DockerStorageThresholds,
  HardeningDefaults,
  ProjectEnforcement,
  NetworkHeadroom,
  IngressHealth,
  IngressIsolationResult,
  GithubSettings,
  GithubInstallation,
  GithubManifestStart,
  GithubDelivery,
  GithubScanEntry,
  GithubImportOutcome,
  ManagedDomain,
  HostnameRenameResult,
  ServerAddress,
  HostnameOverview,
  NetworkGroupView,
  AppVersionInfo,
  NotificationConfig,
  NotificationLogEntry,
  PushConfig,
  PushStatus,
  PushBrowser,
  PushTestResult,
  GitHubPollerConfig,
  ProjectBranchesResult,
  ComposeFileContent,
  ProjectDeploy,
  ProjectDeploymentRevision,
  MetricsData,
  NginxMetrics,
  NginxLogEntriesResult,
  HardwareData,
  ProjectResourceData,
  ProjectResourceSummary,
  ApiToken,
  ActionSummary,
  ComposeVariableStatus,
} from "./types";

// The session itself is an httpOnly cookie the browser holds and scripts cannot read
// (S6). This flag only remembers that we signed in, so the app knows whether to show
// the login page; the server decides whether the session is still valid.
const SIGNED_IN_KEY = "stackport_signed_in";

// Earlier versions kept the session token itself here, readable by any script on the
// page and valid for days. Drop a leftover one.
try { localStorage.removeItem("stackport_token"); } catch { /* storage unavailable */ }

export function markSignedIn(): void {
  try { localStorage.setItem(SIGNED_IN_KEY, "1"); } catch { /* storage unavailable */ }
}

export function markSignedOut(): void {
  try { localStorage.removeItem(SIGNED_IN_KEY); } catch { /* storage unavailable */ }
}

export function isAuthenticated(): boolean {
  try { return localStorage.getItem(SIGNED_IN_KEY) === "1"; } catch { return false; }
}

/** Sent on every API call: the server requires it, with the cookie, on requests that
 *  change state. A page on another site cannot add it without a CORS preflight. */
export function sessionHeaders(): Record<string, string> {
  return { "X-Requested-With": "stackport" };
}

// Deliberately separate from the main token above — a setup-flow session
// (bootstrap or admin-recovery) is a different, short-lived, single-purpose
// credential (see routes/setup.ts) and must never be mistaken for a normal
// logged-in session by isAuthenticated()'s callers. sessionStorage (not
// localStorage) since it's meant to be gone once the tab/setup flow ends.
const SETUP_TOKEN_KEY = "stackport_setup_token";

export function getSetupToken(): string | null {
  return sessionStorage.getItem(SETUP_TOKEN_KEY);
}

export function setSetupToken(token: string): void {
  sessionStorage.setItem(SETUP_TOKEN_KEY, token);
}

export function clearSetupToken(): void {
  sessionStorage.removeItem(SETUP_TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  opts: { skipAuthRedirect?: boolean } = {}
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...sessionHeaders(),
      ...(init.headers ?? {}),
    },
  });

  // On 401 for protected calls, clear token and redirect to login.
  // Skip this for the login endpoint itself — a 401 there means wrong credentials,
  // not an expired session, so we want to show the error in-page.
  if (res.status === 401 && !opts.skipAuthRedirect) {
    markSignedOut();
    window.location.href = "/";
    throw new ApiError(401, "Unauthorized");
  }

  if (res.headers.get("X-Auth-Revoked") === "1") {
    markSignedOut();
    window.location.href = "/";
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: "Request failed" }))) as {
      error?: string;
    };
    throw new ApiError(res.status, body.error ?? "Request failed");
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// Separate from request<T>() above: setup routes use their own short-lived
// setup-token (getSetupToken(), never the main auth token) and a failed call here
// must never trigger request()'s "clear the main token and redirect" 401 handling
// — there's no main session to clear during bootstrap.
async function setupRequest<T>(path: string, init: RequestInit = {}, useToken = true): Promise<T> {
  const token = useToken ? getSetupToken() : null;
  const res = await fetch(`/api/setup${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: "Request failed" }))) as { error?: string };
    throw new ApiError(res.status, body.error ?? "Request failed");
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/**
 * Start (or check on) a long-running action. The server responds 200 when the
 * action was started and 409 when one is already running for that slot — both
 * carry an `ActionStartResponse` body, so neither is treated as an error here.
 */
async function requestActionStart(
  path: string,
  init: RequestInit = { method: "POST" }
): Promise<ActionStartResponse> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...sessionHeaders(),
      ...(init.headers ?? {}),
    },
  });

  if (res.status === 401) {
    markSignedOut();
    window.location.href = "/";
    throw new ApiError(401, "Unauthorized");
  }

  if (res.headers.get("X-Auth-Revoked") === "1") {
    markSignedOut();
    window.location.href = "/";
  }

  const body = (await res.json().catch(() => null)) as ActionStartResponse | { error?: string } | null;
  if (body && "started" in body) return body as ActionStartResponse;
  throw new ApiError(res.status, body?.error ?? "Request failed");
}

/**
 * Same started/busy contract as `requestActionStart`, but for a multipart body —
 * `Content-Type` is intentionally left unset so the browser fills in the
 * multipart boundary itself (setting it manually here would omit the boundary
 * parameter and break parsing server-side).
 */
async function requestActionStartMultipart(path: string, formData: FormData): Promise<ActionStartResponse> {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    headers: sessionHeaders(),
    body: formData,
  });

  if (res.status === 401) {
    markSignedOut();
    window.location.href = "/";
    throw new ApiError(401, "Unauthorized");
  }

  if (res.headers.get("X-Auth-Revoked") === "1") {
    markSignedOut();
    window.location.href = "/";
  }

  const body = (await res.json().catch(() => null)) as ActionStartResponse | { error?: string } | null;
  if (body && "started" in body) return body as ActionStartResponse;
  throw new ApiError(res.status, body?.error ?? "Request failed");
}

function buildQuery(params: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if ((typeof value === "string" || typeof value === "number" || typeof value === "boolean") && value !== "") {
      search.set(key, String(value));
    }
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

export const api = {
  login: (username: string, password: string) =>
    request<{ expiresInHours: number; maxHours: number }>(
      "/auth/login",
      { method: "POST", body: JSON.stringify({ username, password }) },
      { skipAuthRedirect: true }
    ),
  logout: () => request<void>("/auth/logout", { method: "POST" }),

  // Setup — bootstrap (first install) and admin-recovery share this flow. See
  // routes/setup.ts.
  getSetupStatus: () => setupRequest<SetupStatus>("/status", {}, false),
  setupLogin: (username: string, password: string) =>
    setupRequest<SetupLoginResult>("/login", { method: "POST", body: JSON.stringify({ username, password }) }, false),
  setupCreateAdmin: (username: string, password: string) =>
    setupRequest<{ ok: boolean }>("/admin", { method: "POST", body: JSON.stringify({ username, password }) }),
  setupRecovery: (username: string, password: string) =>
    setupRequest<{ ok: boolean }>("/recovery", { method: "POST", body: JSON.stringify({ username, password }) }),

  getLogs: (query: AuditLogQuery = {}) =>
    request<AuditLogResult>(`/logs${buildQuery(query)}`),

  // Projects
  listProjects: () => request<Project[]>("/projects"),
  scanProjectRepoFolders: () => request<ProjectRepoFolderScanResult>("/projects/repo-folder-scan"),
  cleanupOrphanFolder: (path: string) => request<{ ok: boolean; log: string }>("/projects/repo-folder-scan/cleanup", { method: "POST", body: JSON.stringify({ path }), headers: { "Content-Type": "application/json" } }),
  renameRepoFolder: (projectId: number, folder: string) =>
    request<{ ok: boolean; message: string }>("/projects/repo-folder-scan/rename", { method: "POST", body: JSON.stringify({ projectId, folder }), headers: { "Content-Type": "application/json" } }),
  getProject: (id: number) => request<Project>(`/projects/${id}`),
  /** `githubApp` creates the project from a repository the GitHub App can use, bound by id, with no token. */
  createProject: (data: Omit<Partial<Project>, "id" | "createdAt" | "updatedAt" | "lastStatus" | "lastResponseMs" | "lastCheckedAt"> & { githubApp?: { installationId: number; repositoryId: number } }) =>
    request<Project>("/projects", { method: "POST", body: JSON.stringify(data) }),
  updateProject: (id: number, data: Partial<Pick<Project, "name" | "groupName" | "internalPort" | "healthCheckEndpoint" | "healthCheckDomainId" | "healthCheckIntervalS" | "deployHealthGraceS" | "autoRollbackUnhealthy" | "githubRepo" | "credentialId" | "githubCredentialId" | "autoDeployBranch" | "nginxExtraConfig" | "nginxExtraBlocks">>) =>
    request<Project>(`/projects/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  listProjectDomains: (projectId: number) =>
    request<ProjectDomain[]>(`/projects/${projectId}/domains`),
  getProjectIngressTargets: (projectId: number, composeFile?: string) =>
    request<ComposeIngressTarget[]>(`/projects/${projectId}/ingress-targets${buildQuery({composeFile})}`),
  /** Policy violations in the selected Compose file of the checkout. */
  getProjectComposePolicy: (projectId: number) =>
    request<ComposePolicyResult>(`/projects/${projectId}/compose-policy`),
  getProjectComposeVariables: (projectId: number) =>
    request<ComposeVariableStatus[]>(`/projects/${projectId}/compose-variables`),
  getProjectComposeEnvFiles: (projectId: number, composeFile?: string) =>
    request<ComposeEnvFileRef[]>(`/projects/${projectId}/compose-env-files${buildQuery({composeFile})}`),
  addProjectDomain: (projectId: number, domain: string, service: string, containerPort: number) =>
    request<ProjectDomain>(`/projects/${projectId}/domains`, { method: "POST", body: JSON.stringify({ domain, service, containerPort }) }),
  removeProjectDomain: (projectId: number, domainId: number) =>
    request<{ ok: boolean }>(`/projects/${projectId}/domains/${domainId}`, { method: "DELETE" }),
  setProjectDomainSsl: (projectId: number, domainId: number, useSsl: boolean) =>
    request<ProjectDomain>(`/projects/${projectId}/domains/${domainId}`, { method: "PATCH", body: JSON.stringify({ useSsl }) }),
  setProjectDomainRoute: (projectId: number, domainId: number, service: string, containerPort: number) =>
    request<ProjectDomain>(`/projects/${projectId}/domains/${domainId}/route`, { method: "PATCH", body: JSON.stringify({ service, containerPort }) }),
  listTcpExposures: (projectId: number) =>
    request<TcpExposure[]>(`/projects/${projectId}/tcp-exposures`),
  addTcpExposure: (projectId: number, publicPort: number, service: string, containerPort: number) =>
    request<TcpExposure>(`/projects/${projectId}/tcp-exposures`, { method: "POST", body: JSON.stringify({ publicPort, service, containerPort }) }),
  removeTcpExposure: (projectId: number, exposureId: number) =>
    request<{ ok: boolean }>(`/projects/${projectId}/tcp-exposures/${exposureId}`, { method: "DELETE" }),
  deleteProject: (id: number) => request<void>(`/projects/${id}`, { method: "DELETE" }),
  pauseProject: (id: number) => request<Project>(`/projects/${id}/pause`, { method: "POST" }),
  resumeProject: (id: number) => request<Project>(`/projects/${id}/resume`, { method: "POST" }),
  favoriteProject: (id: number) => request<Project>(`/projects/${id}/favorite`, { method: "POST" }),
  unfavoriteProject: (id: number) => request<Project>(`/projects/${id}/unfavorite`, { method: "POST" }),
  setDeployTrigger: (id: number, trigger: DeployTrigger) =>
    request<DeployTriggerResult>(`/projects/${id}/deploy-trigger`, { method: "PUT", body: JSON.stringify({ trigger }) }),
  getProjectWebhook: (id: number) => request<ProjectWebhookInfo>(`/projects/${id}/webhook`),
  pingProjectWebhook: (id: number) => request<{ ok: boolean }>(`/projects/${id}/webhook/ping`, { method: "POST" }),
  reinstallProjectWebhook: (id: number) => request<DeployTriggerResult>(`/projects/${id}/webhook/reinstall`, { method: "POST" }),
  checkProject: (id: number) => request<Project>(`/projects/${id}/check`, { method: "POST" }),
  listProjectEnvFiles: (projectId: number) =>
    request<ProjectEnvFile[]>(`/projects/${projectId}/env-files`),
  createProjectEnvFile: (projectId: number, data: Pick<ProjectEnvFile, "relativePath" | "variables">) =>
    request<ProjectEnvFile>(`/projects/${projectId}/env-files`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateProjectEnvFile: (projectId: number, envId: number, data: Pick<ProjectEnvFile, "relativePath" | "variables">) =>
    request<ProjectEnvFile>(`/projects/${projectId}/env-files/${envId}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  deleteProjectEnvFile: (projectId: number, envId: number) =>
    request<void>(`/projects/${projectId}/env-files/${envId}`, { method: "DELETE" }),
  buildProject: (projectId: number) =>
    requestActionStart(`/projects/${projectId}/build`),
  pullProject: (projectId: number, branch?: string | null) =>
    requestActionStart(`/projects/${projectId}/pull`, branch
      ? { method: "POST", body: JSON.stringify({ branch }) }
      : undefined),
  composeProject: (projectId: number) =>
    requestActionStart(`/projects/${projectId}/compose`),
  recreateProject: (projectId: number) =>
    requestActionStart(`/projects/${projectId}/recreate`),
  forceRebuildProject: (projectId: number) =>
    requestActionStart(`/projects/${projectId}/force-rebuild`),
  redeployProjectContainer: (projectId: number, service: string) =>
    requestActionStart(`/projects/${projectId}/containers/${encodeURIComponent(service)}/redeploy`),
  dropProjectServiceVolumes: (projectId: number, service: string) =>
    requestActionStart(`/projects/${projectId}/containers/${encodeURIComponent(service)}/drop-volumes`),
  deployProject: (projectId: number, branch?: string | null) =>
    requestActionStart(`/projects/${projectId}/deploy`, branch
      ? { method: "POST", body: JSON.stringify({ branch }) }
      : undefined),
  stopProject: (projectId: number) =>
    requestActionStart(`/projects/${projectId}/stop`),
  stopAndPurgeProject: (projectId: number) =>
    requestActionStart(`/projects/${projectId}/stop-purge`),
  setProjectComposeFile: (projectId: number, composeFile: string) =>
    request<Project>(`/projects/${projectId}/compose-file`, {
      method: "PATCH",
      body: JSON.stringify({ composeFile }),
    }),
  getProjectComposeFileContent: (projectId: number) =>
    request<ComposeFileContent>(`/projects/${projectId}/compose-file/content`),
  /** `deploy: false` only stages and validates the files; nothing is started. */
  uploadProjectCompose: (projectId: number, composeFile: File, supportFiles: { file: File; path: string }[], opts: { deploy?: boolean } = {}) => {
    const formData = new FormData();
    formData.append("composeFile", composeFile);
    for (const { file } of supportFiles) formData.append("files", file);
    formData.append("paths", JSON.stringify(supportFiles.map((f) => f.path)));
    if (opts.deploy === false) formData.append("deploy", "false");
    return requestActionStartMultipart(`/projects/${projectId}/upload`, formData);
  },
  getProjectActions: (projectId: number) =>
    request<ProjectActionsSnapshot>(`/projects/${projectId}/actions`),
  listRunningActions: () => request<ActionSummary[]>("/actions/running"),
  getAction: (id: string) => request<ActionSummary>(`/actions/${encodeURIComponent(id)}`),
  getActionLog: async (id: string): Promise<string> => {
    const res = await fetch(`/api/actions/${encodeURIComponent(id)}/log`, { headers: sessionHeaders() });
    return res.ok ? res.text() : "";
  },
  clearProjectActionLogs: (projectId: number) =>
    request<{ deleted: number }>(`/projects/${projectId}/action-logs`, { method: "DELETE" }),
  cancelProjectAction: (projectId: number) =>
    request<{ ok: boolean }>(`/projects/${projectId}/actions/cancel`, { method: "POST" }),
  /** Cached branch list (kept fresh by the GitHub poller); `refresh` forces a live GitHub fetch. */
  getProjectBranches: (projectId: number, refresh = false) =>
    request<ProjectBranchesResult>(`/projects/${projectId}/branches${refresh ? "?refresh=1" : ""}`),
  issueProjectDomainSsl: (projectId: number, domainId: number) =>
    requestActionStart(`/projects/${projectId}/domains/${domainId}/ssl/issue`),
  /** What a deploy would change (commits since the running revision, Compose diff). */
  getDeployPreview: (projectId: number, branch?: string | null) =>
    request<RevisionPreview>(`/projects/${projectId}/deploy-preview${branch ? `?branch=${encodeURIComponent(branch)}` : ""}`),
  /** What a rollback would change; no `deploymentId` previews the default target. */
  getRollbackPreview: (projectId: number, deploymentId?: number) =>
    request<RevisionPreview>(`/projects/${projectId}/rollback-preview${deploymentId ? `?deploymentId=${deploymentId}` : ""}`),
  getProjectDeploys: (projectId: number) =>
    request<ProjectDeploy[]>(`/projects/${projectId}/deploys`),
  listApiTokens: () => request<ApiToken[]>("/api-tokens"),
  createApiToken: (name: string, expiresInDays: number | null, scope: "read" | "write" = "read", projectGroup: string | null = null) =>
    request<{ token: string; record: ApiToken }>("/api-tokens", { method: "POST", body: JSON.stringify({ name, expiresInDays, scope, projectGroup }) }),
  revokeApiToken: (id: number) => request<void>(`/api-tokens/${id}`, { method: "DELETE" }),
  getProjectDeploymentRevisions: (projectId: number) =>
    request<ProjectDeploymentRevision[]>(`/projects/${projectId}/deployments`),
  /** Without `deploymentId`, the server picks the newest earlier revision not rolled back from. */
  rollbackProject: (projectId: number, deploymentId?: number) =>
    requestActionStart(`/projects/${projectId}/rollback`, deploymentId
      ? { method: "POST", body: JSON.stringify({ deploymentId }) }
      : undefined),
  getProjectLogs: (projectId: number, tail: number, service?: string) => {
    const params = new URLSearchParams({ tail: String(tail) });
    if (service) params.set("service", service);
    return request<{ ok: boolean; output: string }>(`/projects/${projectId}/logs?${params}`);
  },

  // Credentials
  listCredentials: () => request<Credential[]>("/credentials"),
  createCredential: (data: { type: "github" | "webhook" | "api_key"; alias: string; username?: string; headerName?: string; secret: string; description?: string }) =>
    request<Credential>("/credentials", { method: "POST", body: JSON.stringify(data) }),
  setDefaultCredential: (id: number) =>
    request<Credential>(`/credentials/${id}/default`, { method: "POST" }),
  clearDefaultCredential: () =>
    request<void>("/credentials/default", { method: "DELETE" }),
  deleteCredential: (id: number) => request<void>(`/credentials/${id}`, { method: "DELETE" }),

  // System
  getSystem: () => request<SystemData>("/system"),
  getVersion: () => request<AppVersionInfo>("/system/version"),
  getSelfUpdateStatus: () => request<SelfUpdateStatus | null>("/system/update/status"),
  runSelfUpdate: () => request<SelfUpdateStatus>("/system/update", { method: "POST" }),
  checkAppUpdate: () => request<AppUpdateCheck>("/system/update/check"),
  getUpdateConfig: () => request<SystemUpdateConfig>("/system/update-config"),
  updateUpdateConfig: (credentialId: number | null) =>
    request<SystemUpdateConfig>("/system/update-config", { method: "PUT", body: JSON.stringify({ credentialId }) }),
  getHardeningDefaults: () => request<HardeningDefaults>("/system/hardening-defaults"),
  updateHardeningDefaults: (values: HardeningDefaults) =>
    request<HardeningDefaults>("/system/hardening-defaults", { method: "PUT", body: JSON.stringify(values) }),
  setProjectComposePolicyEnforcement: (projectId: number, enforced: boolean) =>
    request<{ composePolicyEnforced: boolean }>(`/projects/${projectId}/compose-policy-enforcement`, { method: "PUT", body: JSON.stringify({ enforced }) }),
  rotateGithubCredentials: (input: { privateKey?: string; webhookSecret?: string }) =>
    request<{ privateKey: boolean; webhookSecret: boolean }>("/github-app/credentials", { method: "PUT", body: JSON.stringify(input) }),
  setProjectGithubDeployOn: (projectId: number, mode: "push" | "ci" | "release") =>
    request<{ githubDeployOn: "push" | "ci" | "release" }>(`/projects/${projectId}/github-deploy-on`, { method: "PUT", body: JSON.stringify({ mode }) }),
  scanGithubInstallation: (installationId: number) =>
    request<{ entries: GithubScanEntry[]; truncated: boolean; warning: string }>("/github-app/import/scan", { method: "POST", body: JSON.stringify({ installationId }) }),
  importGithubRepositories: (installationId: number, repositoryIds: number[]) =>
    request<{ outcomes: GithubImportOutcome[] }>("/github-app/import", { method: "POST", body: JSON.stringify({ installationId, repositoryIds }) }),
  getGithubDeliveries: () => request<{ deliveries: GithubDelivery[] }>("/github-app/deliveries"),
  replayGithubDelivery: (deliveryId: string) =>
    request<{ status: string; deliveries: GithubDelivery[] }>(`/github-app/deliveries/${encodeURIComponent(deliveryId)}/replay`, { method: "POST" }),
  getGithubRepositories: () =>
    request<{ repositories: { repositoryId: number; installationId: number; fullName: string; defaultBranch: string | null; isPrivate: boolean }[] }>("/github-app/repositories"),
  setProjectGithubAuth: (projectId: number, input: { mode: "app" | "token"; installationId?: number; repositoryId?: number }) =>
    request<{ githubAuthMode: "app" | null }>(`/projects/${projectId}/github-auth`, { method: "PUT", body: JSON.stringify(input) }),
  renameProjectHostname: (projectId: number, domainId: number, input: { managedDomainId: number; label: string; canonical?: "apex" | "www" }) =>
    request<HostnameRenameResult>(`/projects/${projectId}/domains/${domainId}/rename`, { method: "POST", body: JSON.stringify(input) }),
  getDomainSettings: () => request<{ server: ServerAddress }>("/domains/settings"),
  setServerAddress: (publicAddress: string | null) =>
    request<{ server: ServerAddress }>("/domains/settings", { method: "PUT", body: JSON.stringify({ publicAddress }) }),
  checkManagedDomain: (id: number) => request<{ domains: ManagedDomain[] }>(`/domains/${id}/check`, { method: "POST" }),
  getManagedDomains: () => request<{ domains: ManagedDomain[] }>("/domains"),
  getHostnames: () => request<{ hostnames: HostnameOverview[] }>("/domains/hostnames"),
  addManagedDomain: (name: string, isDefault = false) =>
    request<{ domain: ManagedDomain; domains: ManagedDomain[] }>("/domains", { method: "POST", body: JSON.stringify({ name, isDefault }) }),
  setDefaultManagedDomain: (id: number) =>
    request<{ domains: ManagedDomain[] }>(`/domains/${id}`, { method: "PATCH", body: JSON.stringify({ isDefault: true }) }),
  removeManagedDomain: (id: number) => request<{ domains: ManagedDomain[] }>(`/domains/${id}`, { method: "DELETE" }),
  addManagedProjectDomain: (projectId: number, input: { managedDomainId: number; label: string; canonical?: "apex" | "www"; service: string; containerPort: number }) =>
    request<ProjectDomain>(`/projects/${projectId}/domains`, { method: "POST", body: JSON.stringify(input) }),
  getGithubSettings: () => request<GithubSettings>("/github-app"),
  startGithubManifest: (input: { modules: string[]; owner: string; isPublic: boolean }) =>
    request<GithubManifestStart>("/github-app/manifest/start", { method: "POST", body: JSON.stringify(input) }),
  startGithubLink: () => request<{ authorizeUrl: string }>("/github-app/link/start", { method: "POST" }),
  syncGithubInstallations: () => request<{ installations: GithubInstallation[] }>("/github-app/installations/sync", { method: "POST" }),
  refreshGithubInstallation: (installationId: number) =>
    request<{ repositories: number }>(`/github-app/installations/${installationId}/refresh`, { method: "POST" }),
  forgetGithubApp: () => request<void>("/github-app", { method: "DELETE" }),
  setProjectIngressIsolation: (projectId: number, enabled: boolean) =>
    request<IngressIsolationResult>(`/projects/${projectId}/ingress-isolation`, { method: "PUT", body: JSON.stringify({ enabled }) }),
  getProjectIngressHealth: (projectId: number) => request<IngressHealth>(`/projects/${projectId}/ingress-health`),
  getNetworkHeadroom: () => request<NetworkHeadroom>("/system/network-headroom"),
  getProjectEnforcement: () => request<{ projects: ProjectEnforcement[] }>("/system/project-enforcement"),
  getProjectNetworkGroup: (projectId: number) => request<NetworkGroupView>(`/projects/${projectId}/network-group`),
  setProjectNetworkGroup: (projectId: number, group: string, services: string[]) =>
    request<NetworkGroupView>(`/projects/${projectId}/network-group`, { method: "PUT", body: JSON.stringify({ group, services }) }),
  setProjectHardening: (projectId: number, enabled: boolean) =>
    request<{ hardenedDefaults: boolean }>(`/projects/${projectId}/hardening`, { method: "PUT", body: JSON.stringify({ enabled }) }),
  getDockerStorageThresholds: () => request<DockerStorageThresholds>("/system/docker/storage-thresholds"),
  updateDockerStorageThresholds: (thresholds: DockerStorageThresholds) =>
    request<DockerStorageThresholds>("/system/docker/storage-thresholds", { method: "PUT", body: JSON.stringify(thresholds) }),
  reloadNginx: () => request<{ ok: boolean; output: string }>("/system/nginx/reload", { method: "POST" }),
  applyNginx: () => requestActionStart("/system/nginx/apply"),
  updateNginxAppConfig: (data: { enabled: boolean; domain: string; useSsl: boolean }) =>
    requestActionStart("/system/nginx/app", { method: "PUT", body: JSON.stringify(data) }),
  getSystemActions: () => request<SystemActionsSnapshot>("/system/actions"),
  getNginxDocument: (kind: NginxDocumentKind) =>
    request<NginxDocument>(`/system/nginx/files/${kind}`),
  updateNginxTemplate: (kind: Extract<NginxDocumentKind, "general" | "project">, content: string) =>
    request<NginxDocument>(`/system/nginx/files/${kind}`, {
      method: "PUT",
      body: JSON.stringify({ content }),
    }),
  composeAction: (stack: string, action: "up" | "down" | "build") =>
    request<ComposeActionResult>(`/system/docker/compose/${encodeURIComponent(stack)}/${action}`, { method: "POST" }),
  pruneDockerBuildCache: () => requestActionStart("/system/docker/prune"),
  getDockerContainerLogs: (containerId: string, lines = 200) =>
    request<DockerContainerLogsResult>(
      `/system/docker/containers/${encodeURIComponent(containerId)}/logs${buildQuery({ lines })}`
    ),
  certbotAction: (domain: string, action: "issue" | "renew" | "delete") =>
    requestActionStart(`/system/certbot/${encodeURIComponent(domain)}/${action}`),
  updateCertbotEmail: (email: string) =>
    request<CertbotEmailConfig>("/system/certbot/email", {
      method: "PUT",
      body: JSON.stringify({ email }),
    }),
  // GitHub Poller
  getGithubPollerConfig: () => request<GitHubPollerConfig>("/github-poller"),
  updateGithubPollerConfig: (data: { enabled?: boolean; credentialId?: number | null; pollIntervalS?: number; webhookSafetyCheck?: boolean }) =>
    request<GitHubPollerConfig>("/github-poller", { method: "PUT", body: JSON.stringify(data) }),
  triggerGithubPoll: () => request<{ ok: boolean }>("/github-poller/poll", { method: "POST" }),

  // Admin
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: boolean }>("/admin/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  // Notifications
  getNotificationConfig: () => request<NotificationConfig>("/notifications"),
  updateNotificationConfig: (data: {
    enabled?: boolean;
    provider?: string;
    credentialId?: number | null;
    fromAddress?: string;
    toAddress?: string;
  }) => request<NotificationConfig>("/notifications", { method: "PUT", body: JSON.stringify(data) }),
  testNotification: () => request<{ ok: boolean }>("/notifications/test", { method: "POST" }),
  getNotificationLogs: () => request<NotificationLogEntry[]>("/notifications/logs"),
  getPushConfig: () => request<PushConfig>("/notifications/push/config"),
  getPushStatus: () => request<PushStatus>("/notifications/push/status"),
  resolvePushBrowser: (data: PushSubscriptionJSON) => request<PushBrowser | null>("/notifications/push/subscriptions/resolve", { method: "POST", body: JSON.stringify(data) }),
  updatePushConfig: (data: Pick<PushConfig, "enabled" | "subject" | "events">) =>
    request<PushConfig>("/notifications/push/config", { method: "PUT", body: JSON.stringify(data) }),
  listPushBrowsers: () => request<PushBrowser[]>("/notifications/push/subscriptions"),
  savePushBrowser: (data: PushSubscriptionJSON & { label: string }) =>
    request<PushBrowser>("/notifications/push/subscriptions", { method: "POST", body: JSON.stringify(data) }),
  removePushBrowser: (id: number) => request<{ ok: boolean }>(`/notifications/push/subscriptions/${id}`, { method: "DELETE" }),
  testPush: (subscriptionId?: number) => request<PushTestResult>("/notifications/push/test", {
    method: "POST", body: JSON.stringify({ subscriptionId }),
  }),

  // Metrics
  getMetrics: (days?: number, projectIds?: number[]) => request<MetricsData>(`/metrics${buildQuery({ days: days ?? "", projects: projectIds?.join(",") ?? "" })}`),
  getNginxMetrics: (params?: { period?: string; excludeServerIp?: boolean; excludeHealthChecks?: boolean }) =>
    request<NginxMetrics>(`/metrics/nginx${buildQuery(params ?? {})}`),
  getNginxLogEntries: (params?: { period?: string; excludeServerIp?: boolean; excludeHealthChecks?: boolean; host?: string; limit?: number }) =>
    request<NginxLogEntriesResult>(`/metrics/nginx/requests${buildQuery(params ?? {})}`),
  clearNginxLogs: () => request<{ ok: boolean }>("/metrics/nginx/clear", { method: "POST" }),

  // Hardware
  getHardware: (hours?: number) => request<HardwareData>(`/hardware${buildQuery({ hours: hours ?? "" })}`),

  // Project resource usage (per docker compose stack)
  getProjectResources: (projectId: number, hours?: number) =>
    request<ProjectResourceData>(`/projects/${projectId}/resources${buildQuery({ hours: hours ?? "" })}`),
  getProjectResourcesSummary: (hours?: number) =>
    request<ProjectResourceSummary>(`/projects/resources-summary${buildQuery({ hours: hours ?? "" })}`),
  getProjectResourcesTimeseries: (params: { hours?: number; metric: ResourceMetric; projectIds?: number[] }) =>
    request<ProjectResourcesTimeseries>(`/projects/resources-timeseries${buildQuery({
      hours: params.hours ?? "",
      metric: params.metric,
      projectIds: params.projectIds && params.projectIds.length > 0 ? params.projectIds.join(",") : "",
    })}`),
};
