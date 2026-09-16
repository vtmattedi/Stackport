export interface Project {
  groupName: string | null;
  id: number;
  name: string;
  internalPort: number | null;
  healthCheckEndpoint: string | null;
  healthCheckIntervalS: number;
  lastStatus: "up" | "down" | "unknown";
  lastResponseMs: number | null;
  lastCheckedAt: string | null;
  githubRepo: string | null;
  credentialId: number | null;
  githubCredentialId: number | null;
  paused: boolean;
  favorite: boolean;
  autoDeployBranch: string | null;
  lastCommitSha: string | null;
  lastCommitMessage: string | null;
  lastCommitAuthor: string | null;
  lastCommitAt: string | null;
  branches: GitHubBranch[];
  sourceType: "github" | "upload";
  nginxExtraConfig: string | null;
  nginxExtraBlocks: string | null;
  composeFile: string | null;
  availableComposeFiles: string[];
  /** Only populated by the list (GET /projects) and single (GET /projects/:id) reads —
   *  other project-mutating responses don't attach it. Use `project.domains ?? []`. */
  domains?: ProjectDomain[];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDomain {
  id: number;
  projectId: number;
  domain: string;
  useSsl: boolean;
  service: string;
  containerPort: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ComposeIngressTarget {
  service: string;
  containerPort: number;
}

export interface GitHubPollerConfig {
  enabled: boolean;
  credentialId: number | null;
  pollIntervalS: number;
  lastPolledAt: string | null;
  lastError: string | null;
  lastPollOutput: string | null;
  updatedAt: string | null;
}

export interface GitHubBranch {
  name: string;
  sha: string;
  commitMessage: string | null;
  commitAuthor: string | null;
  commitAt: string | null;
}

export interface ProjectDeploy {
  id: number;
  projectId: number;
  commitSha: string | null;
  commitMessage: string | null;
  commitAuthor: string | null;
  triggeredBy: "manual" | "auto";
  status: "running" | "success" | "failed";
  createdAt: string;
  completedAt: string | null;
}

/** Phase 1.7 — a revision/snapshot record (not the same as ProjectDeploy above,
 *  which is an auto-deploy metrics log). Backs rollback: each row is a deploy
 *  attempt with enough stored state (commit + resolved compose file) to restore
 *  exactly what was running, not just a status/timestamp. */
export interface ProjectDeploymentRevision {
  id: number;
  projectId: number;
  commitSha: string | null;
  branch: string | null;
  composeFileName: string | null;
  status: "active" | "failed" | "superseded";
  triggeredBy: string;
  blockedReason: string | null;
  createdAt: string;
}

export interface EnvVariable {
  key: string;
  value: string;
}

export interface ProjectEnvFile {
  id: number;
  projectId: number;
  relativePath: string;
  variables: EnvVariable[];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDeployResult {
  ok: boolean;
  projectId: number;
  repoPath: string;
  output: string;
  action: "build" | "deploy" | "stop" | "stop-purge" | "pull" | "compose" | "recreate" | "force-rebuild" | "redeploy-service" | "drop-volumes";
}

export interface ComposeFileContent {
  fileName: string;
  content: string;
}

export interface ProjectRepoFolderScanProject {
  projectId: number;
  name: string;
  githubRepo: string | null;
  expectedFolder: string;
  expectedPath: string;
}

export interface ProjectRepoFolderScanFolder {
  folder: string;
  path: string;
  projectId: number | null;
  projectName: string | null;
  githubRepo: string | null;
  expectedFolder: string | null;
  status: "matched" | "name-mismatch" | "no-project" | "unparseable";
  hasCompose: boolean;
}

export interface ProjectRepoFolderScanResult {
  deployRoot: string;
  folders: ProjectRepoFolderScanFolder[];
  missingProjectFolders: ProjectRepoFolderScanProject[];
  orphanFolders: ProjectRepoFolderScanFolder[];
  nameMismatches: ProjectRepoFolderScanFolder[];
}

export interface ProjectUpdateEvent {
  projectId: number;
  project: Project;
  ok: boolean;
  output: string;
}

export interface ProjectBranchesResult {
  branches: GitHubBranch[];
  autoDeployBranch: string | null;
}

export interface ProjectDeployEvent {
  projectId: number;
  action: "build" | "deploy" | "stop" | "stop-purge" | "pull" | "compose" | "upload" | "recreate" | "force-rebuild" | "redeploy-service" | "drop-volumes";
  stream: "stdout" | "stderr" | "status";
  message: string;
  ok?: boolean;
  done?: boolean;
}

/** Lean, push-only companion to ProjectDeployEvent — arrives only when the build
 *  progress estimate actually changes, not on every raw output chunk. No log/message
 *  field; on `done`, fetch the final ActionRecord (GET /projects/:id/actions) once
 *  for the full success/fail detail. */
export interface ProjectBuildProgressEvent {
  projectId: number;
  phase: BuildPhase;
  progress: number;
  done?: boolean;
  ok?: boolean;
}

export interface ShellStartPayload {
  containerId: string;
  cols: number;
  rows: number;
}

export type ShellStartAck = { ok: true; sessionId: string } | { ok: false; error: string };

export interface ShellInputPayload {
  sessionId: string;
  data: string;
}

export interface ShellStopPayload {
  sessionId: string;
}

export interface ShellDataEvent {
  sessionId: string;
  chunk: string;
}

export interface ShellExitEvent {
  sessionId: string;
  code: number | null;
  signal: string | null;
}

export interface LogsStartPayload {
  containerId: string;
}

export type LogsStartAck = { ok: true; sessionId: string } | { ok: false; error: string };

export interface LogsStopPayload {
  sessionId: string;
}

export interface LogsDataEvent {
  sessionId: string;
  chunk: string;
}

export interface LogsExitEvent {
  sessionId: string;
  code: number | null;
  signal: string | null;
}

export type ActionStatus = "running" | "success" | "failed";

export type BuildPhase = "preparing" | "pulling" | "building" | "deploying" | "starting";

export interface ActionRecord {
  id: string;
  key: string;
  kind: string;
  projectId?: number;
  meta?: Record<string, unknown>;
  status: ActionStatus;
  ok: boolean | null;
  startedAt: string;
  completedAt: string | null;
  log: string;
  /** Best-effort build-progress estimate — only populated for actions that run
   *  docker compose; null for everything else (nginx apply, certbot, docker prune,
   *  a bare git pull with no build step). */
  phase: BuildPhase | null;
  progress: number | null;
}

export interface ActionStartResponse {
  ok: boolean;
  started: boolean;
  action: ActionRecord | null;
  error?: string;
}

export interface ProjectActionsSnapshot {
  repo: ActionRecord | null;
  /** One entry per domain currently being (or having just finished) SSL-issued —
   *  each record's meta.domainId identifies which project_domains row it's for. */
  ssl: ActionRecord[];
}

export interface SystemActionsSnapshot {
  nginx: ActionRecord | null;
  certbot: ActionRecord[];
  docker: ActionRecord | null;
}

export interface RunningProjectAction {
  action: ActionRecord;
  projectId: number | null;
  projectName: string | null;
}

export interface Credential {
  id: number;
  type: string;
  alias: string;
  username: string | null;
  headerName: string | null;
  isDefault: boolean;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

// Normalized VM data returned by GET /vps
export interface VmData {
  providerId?: number;
  id?: number | string;
  hostname?: string;
  state?: string;
  cpus?: number;
  plan?: string;
  ipAddresses?: string[];
  cpu: { pct: number };
  ram: { bytes: number; totalBytes: number };
  disk: { bytes: number; totalBytes: number };
  network: { inBytes: number; outBytes: number };
  uptimeSec: number;
  fetchedAt: string;
}

// Raw fallbacks kept for /info and /metrics passthrough endpoints
export type VmInfo = Record<string, unknown>;
export type VmMetrics = Record<string, unknown>;
export type VmDebug = Record<string, unknown>;

export interface VpsProvider {
  id: number;
  type: "hostinger";
  name: string;
  hasApiKey: boolean;
  credentialId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface MonitoredVm {
  id: number;
  providerId: number;
  vmId: string;
  label: string | null;
  createdAt: string;
}

export interface VpsData {
  configured: boolean;
  providers: VpsProvider[];
  monitored: MonitoredVm[];
  vms: VmData[];
  vps: VmData | null;
}

export type FirewallAction = "accept" | "drop";
export type FirewallProtocol = "TCP" | "UDP" | "ICMP" | "GRE" | "any" | "ESP" | "AH" | "ICMPv6" | "SSH" | "HTTP" | "HTTPS" | "MySQL" | "PostgreSQL";
export type FirewallSource = "any" | "custom";

export interface FirewallRule {
  id: number;
  profileId: number;
  action: FirewallAction;
  protocol: FirewallProtocol;
  port: string;
  source: FirewallSource;
  sourceDetail: string;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface FirewallProfile {
  id: number;
  providerId: number;
  name: string;
  remoteFirewallId: string | null;
  rules: FirewallRule[];
  createdAt: string;
  updatedAt: string;
}

export interface ProviderFirewallRule {
  id?: number | string;
  action?: string;
  protocol?: string;
  port?: string;
  source?: string;
  source_detail?: string;
}

export interface ProviderFirewall {
  id?: number | string;
  name?: string;
  is_synced?: boolean;
  rules?: ProviderFirewallRule[];
  data?: {
    id?: number | string;
    name?: string;
    is_synced?: boolean;
    rules?: ProviderFirewallRule[];
  };
}

export interface FirewallSyncResult {
  profile: FirewallProfile;
  firewall: ProviderFirewall;
  createdRemote: boolean;
  deletedRules: number;
  createdRules: number;
  activate: Record<string, unknown> | null;
  sync: Record<string, unknown> | null;
}

export interface AuditEntry {
  ts: string;
  actor: string;
  action: string;
  target: string;
  result: "ok" | "fail";
  meta?: Record<string, unknown>;
}

export interface AuditLogQuery {
  actor?: string;
  action?: string;
  target?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export interface AuditLogResult {
  entries: AuditEntry[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface ContainerStats {
  cpu: string;
  mem: string;
  memPerc: string;
  netIO: string;
  blockIO: string;
}

export interface ContainerInfo {
  id: string;
  name: string;
  service: string | null;
  image: string;
  state: string;
  status: string;
  ports: string;
  stats: ContainerStats | null;
}

export interface ComposeStack {
  name: string;
  status: string;
  configFiles: string[];
  containers: ContainerInfo[];
}

export interface DockerDiskUsageEntry {
  type: string;
  totalCount: string;
  active: string;
  size: string;
  reclaimable: string;
}

export interface DockerStorageThresholds {
  warningFreeBytes: number;
  warningFreePct: number;
  criticalFreeBytes: number;
  criticalFreePct: number;
}

export interface DockerStorageStatus {
  state: "normal" | "warning" | "critical" | "unknown";
  freeBytes: number | null;
  totalBytes: number | null;
  freePct: number | null;
  thresholds: DockerStorageThresholds;
}

export interface DockerData {
  available: boolean;
  reason?: string;
  version?: string;
  stacks: ComposeStack[];
  standalone: ContainerInfo[];
  diskUsage: DockerDiskUsageEntry[];
  storage: DockerStorageStatus;
}

export interface NginxData {
  available: boolean;
  reason?: string;
  version?: string;
  active?: boolean;
  configTest?: { ok: boolean; output: string };
  layer?: NginxLayerStatus;
}

export interface NginxLayerStatus {
  mode: "real";
  rootPath: string;
  targetPath: string;
  generalTemplatePath: string;
  projectTemplatePath: string;
  fixedBlockPath: string;
  domainTemplatePath: string;
  backupDir: string;
  exists: boolean;
  failedConfigExists: boolean;
  sizeBytes: number | null;
  domains: string[];
  domainList: string[];
  subdomainList: string[];
  routes: NginxRouteSummary[];
  backupCount: number;
  app: NginxAppConfig;
  lastOperation: {
    ok: boolean;
    mode: "real";
    targetPath: string;
    backupPath: string | null;
    restored: boolean;
    output: string;
    updatedAt: string;
    restartCount: number;
  } | null;
}

export interface NginxAppConfig {
  enabled: boolean;
  domain: string;
  port: number;
  useSsl: boolean;
}

export interface NginxRouteSummary {
  project: string;
  domain: string;
  service: string;
  port: number;
}

export interface SystemData {
  docker: DockerData;
  nginx: NginxData;
  certbot: CertbotData;
  version: AppVersionInfo | null;
}

export interface BuildInfo {
  name: string;
  version: string;
  builtAt: string | null;
  gitCommit: string;
  gitBranch: string;
  gitMessage: string;
}

export interface AppVersionInfo {
  backend: BuildInfo;
  frontend: BuildInfo;
}

export interface ComposeActionResult {
  ok: boolean;
  output: string;
}

export interface DockerContainerLogsResult {
  ok: boolean;
  containerId: string;
  lines: number;
  output: string;
}

export interface CertbotEntry {
  domain: string;
  type: "domain" | "subdomain";
  hasCertificate: boolean;
  status: "missing" | "valid" | "expiring" | "expired" | "unknown";
  expiresAt: string | null;
  issuer: string | null;
  path: string | null;
}

export interface CertbotData {
  mode: "real";
  available: boolean;
  reason?: string;
  emailConfigured: boolean;
  email: string;
  rootPath: string;
  entries: CertbotEntry[];
}

export interface CertbotEmailConfig {
  email: string;
  emailConfigured: boolean;
  source: "client" | "env" | "none";
}

export interface CertbotActionResult {
  ok: boolean;
  mode: "real";
  domain: string;
  action: "issue" | "renew" | "delete";
  output: string;
}

export interface NotificationConfig {
  enabled: boolean;
  provider: "resend" | "mw";
  hasApiKey: boolean;
  credentialId: number | null;
  fromAddress: string;
  toAddress: string;
  updatedAt: string | null;
}

export interface NginxApplyResult {
  ok: boolean;
  mode: "real";
  targetPath: string;
  backupPath: string | null;
  restored: boolean;
  output: string;
}


export interface SelfUpdateStatus {
  id: string;
  status: "running" | "success" | "failed" | "rolled-back";
  output: string;
}

export interface SetupStatus {
  initialized: boolean;
}

export interface SetupLoginResult {
  token: string;
  kind: "bootstrap" | "recovery";
  expiresIn: number;
}

export interface AppUpdateCheck {
  ok: boolean;
  repo: string | null;
  branch: string | null;
  localCommit: string | null;
  remoteCommit: string | null;
  hasUpdate: boolean;
  output: string;
}

export interface SystemUpdateConfig {
  credentialId: number | null;
}


export interface GlobalRealtimeEvent {
  id: string;
  type: "nginx:flow" | "system:update" | "docker:flow";
  status: "started" | "running" | "success" | "failed";
  title: string;
  message: string;
  projectId?: number;
  projectName?: string;
  /** SSL-issue flow only — disambiguates "this project's this domain" when a
   *  project has several domains issuing SSL concurrently. */
  domainId?: number;
  updateMode?: "full" | "frontend";
  output?: string;
  stream?: "stdout" | "stderr" | "status";
  step?: string;
  done?: boolean;
  createdAt: string;
}

export type NginxDocumentKind = "generated" | "general" | "project" | "failed";

export interface NginxDocument {
  kind: NginxDocumentKind;
  path: string;
  editable: boolean;
  content: string;
  updatedAt: string | null;
  sizeBytes: number | null;
}

export interface NotificationLogEntry {
  id: number;
  eventType: string;
  recipient: string;
  subject: string;
  result: "ok" | "error";
  errorMessage: string | null;
  projectName: string | null;
  sentAt: string;
}

export interface MetricsData {
  deploys: {
    total: number;
    success: number;
    failed: number;
    byDay: Array<{ date: string; success: number; failed: number }>;
    recentFailures: Array<{ id: number; projectId: number; projectName: string; createdAt: string }>;
  };
  healthChecks: {
    projects: Array<{
      id: number;
      name: string;
      status: string;
      lastCheckedAt: string | null;
      lastResponseMs: number | null;
    }>;
  };
  notifications: {
    total: number;
    success: number;
    failed: number;
  };
}

export interface NginxDomainStat {
  host: string;
  requests: number;
  errors: number;
  bytes: number;
  avgRtMs: number | null;
  statusCodes: Record<string, number>;
  methodCounts: Record<string, number>;
  topPaths: Array<{ path: string; count: number }>;
  timeSeries: Array<{ ts: string; count: number; errors: number }>;
}

export interface NginxMetrics {
  available: boolean;
  error?: string;
  logPath?: string;
  period?: string;
  serverIps?: string[];
  totalRequests?: number;
  errorRate?: number;
  statusCodes?: Record<string, number>;
  topPaths?: Array<{ path: string; count: number }>;
  timeSeries?: Array<{ ts: string; count: number; errors: number }>;
  granularity?: "hour" | "day";
  domains?: NginxDomainStat[];
  bytesTotal?: number;
  uniqueIps?: number;
  botRequests?: number;
  methodCounts?: Record<string, number>;
  p50ResponseMs?: number | null;
  p95ResponseMs?: number | null;
  hasExtendedFormat?: boolean;
}

export interface NginxLogEntry {
  time: string;
  ip: string;
  method: string;
  path: string;
  status: number;
  bytes: number;
  ua: string | null;
  host: string | null;
  requestTimeMs: number | null;
}

export interface NginxLogEntriesResult {
  available: boolean;
  error?: string;
  logPath?: string;
  period?: string;
  serverIps?: string[];
  hasExtendedFormat?: boolean;
  entries: NginxLogEntry[];
  truncated: boolean;
}

export interface HardwareSample {
  cpuPercent: number;
  memPercent: number;
  memUsedMb: number;
  memTotalMb: number;
  load1: number;
  sampledAt: string;
}

export interface HardwareHistoryPoint {
  ts: string;
  cpuAvg: number;
  cpuMax: number;
  memAvg: number;
  memMax: number;
  load1: number;
}

export interface HardwareData {
  cpuCount: number;
  hostname: string;
  latest: HardwareSample | null;
  history: HardwareHistoryPoint[];
}

export interface ProjectResourceSample {
  cpuPercent: number;
  memUsedMb: number;
  memLimitMb: number;
  memPercent: number;
  netRxMb: number;
  netTxMb: number;
  sampledAt: string;
}

export interface ProjectResourceHistoryPoint {
  ts: string;
  cpuAvg: number;
  cpuMax: number;
  memAvg: number;
  memMax: number;
  memUsedMb: number;
  netRxMb: number;
  netTxMb: number;
}

export interface ProjectFolderSizeSample {
  sizeBytes: number;
  sampledAt: string;
}

export interface ProjectFolderSizeHistoryPoint {
  ts: string;
  sizeBytes: number;
}

/** Mirrors src/services/realtime.ts's ProjectResourceSampleEvent — pushed live
 *  on the `project:${id}` room the instant the sampler writes a new sample. */
export interface ProjectResourceSampleEvent {
  projectId: number;
  sample: ProjectResourceSample;
}

export interface ProjectResourceData {
  latest: ProjectResourceSample | null;
  history: ProjectResourceHistoryPoint[];
  diskSize: {
    latest: ProjectFolderSizeSample | null;
    history: ProjectFolderSizeHistoryPoint[];
  };
}

export interface ProjectResourceSummaryItem {
  projectId: number;
  name: string;
  cpuPercent: number;
  memUsedMb: number;
  memPercent: number;
  netRxMb: number;
  netTxMb: number;
  diskSizeMb: number | null;
  sampledAt: string | null;
}

export interface ProjectResourceSummary {
  projects: ProjectResourceSummaryItem[];
}

export type ResourceMetric = "cpu" | "mem" | "net" | "disk";

export interface ProjectResourceTimeseriesSeries {
  projectId: number;
  name: string;
  values: (number | null)[];
}

export interface ProjectResourcesTimeseries {
  buckets: string[];
  granularity: "5m" | "day";
  series: ProjectResourceTimeseriesSeries[];
}
