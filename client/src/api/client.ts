import type {
  AuditLogQuery,
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
  AppVersionInfo,
  NotificationConfig,
  NotificationLogEntry,
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

const TOKEN_KEY = "stackport_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export function isAuthenticated(): boolean {
  return !!getToken();
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
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });

  // On 401 for protected calls, clear token and redirect to login.
  // Skip this for the login endpoint itself — a 401 there means wrong credentials,
  // not an expired session, so we want to show the error in-page.
  if (res.status === 401 && !opts.skipAuthRedirect) {
    clearToken();
    window.location.href = "/";
    throw new ApiError(401, "Unauthorized");
  }

  if (res.headers.get("X-Auth-Revoked") === "1") {
    clearToken();
    window.location.href = "/";
  } else {
    const refreshedToken = res.headers.get("X-Auth-Token");
    if (refreshedToken) {
      setToken(refreshedToken);
    }
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
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });

  if (res.status === 401) {
    clearToken();
    window.location.href = "/";
    throw new ApiError(401, "Unauthorized");
  }

  if (res.headers.get("X-Auth-Revoked") === "1") {
    clearToken();
    window.location.href = "/";
  } else {
    const refreshedToken = res.headers.get("X-Auth-Token");
    if (refreshedToken) setToken(refreshedToken);
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
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    method: "POST",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: formData,
  });

  if (res.status === 401) {
    clearToken();
    window.location.href = "/";
    throw new ApiError(401, "Unauthorized");
  }

  if (res.headers.get("X-Auth-Revoked") === "1") {
    clearToken();
    window.location.href = "/";
  } else {
    const refreshedToken = res.headers.get("X-Auth-Token");
    if (refreshedToken) setToken(refreshedToken);
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
    request<{ token: string; expiresIn: string }>(
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
  createProject: (data: Omit<Partial<Project>, "id" | "createdAt" | "updatedAt" | "lastStatus" | "lastResponseMs" | "lastCheckedAt">) =>
    request<Project>("/projects", { method: "POST", body: JSON.stringify(data) }),
  updateProject: (id: number, data: Partial<Pick<Project, "name" | "groupName" | "internalPort" | "healthCheckEndpoint" | "healthCheckDomainId" | "healthCheckIntervalS" | "deployHealthGraceS" | "autoRollbackUnhealthy" | "githubRepo" | "credentialId" | "githubCredentialId" | "autoDeployBranch" | "nginxExtraConfig" | "nginxExtraBlocks">>) =>
    request<Project>(`/projects/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  listProjectDomains: (projectId: number) =>
    request<ProjectDomain[]>(`/projects/${projectId}/domains`),
  getProjectIngressTargets: (projectId: number, composeFile?: string) =>
    request<ComposeIngressTarget[]>(`/projects/${projectId}/ingress-targets${buildQuery({composeFile})}`),
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
    const token = getToken();
    const res = await fetch(`/api/actions/${encodeURIComponent(id)}/log`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
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
  getProjectDeploys: (projectId: number) =>
    request<ProjectDeploy[]>(`/projects/${projectId}/deploys`),
  listApiTokens: () => request<ApiToken[]>("/api-tokens"),
  createApiToken: (name: string, expiresInDays: number | null) =>
    request<{ token: string; record: ApiToken }>("/api-tokens", { method: "POST", body: JSON.stringify({ name, expiresInDays }) }),
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
