export interface ProjectBranch {
  name: string;
  sha: string;
  commitMessage: string | null;
  commitAuthor: string | null;
  commitAt: string | null;
}

export interface Project {
  groupName: string | null;
  id: number;
  name: string;
  internalPort: number | null;
  healthCheckEndpoint: string | null;
  healthCheckDomainId: number | null;
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
  branches: ProjectBranch[];
  branchesFetchedAt: string | null;
  /** How new commits on the auto-deploy branch reach this project. */
  deployTrigger: DeployTrigger;
  /** A commit waiting for the project's action slot; deployed when the running action ends. */
  pendingDeploySha: string | null;
  /** Last time the poller checked this project's repo, and the error if that check failed. */
  githubCheckedAt: string | null;
  githubCheckError: string | null;
  /** GitHub webhook state when deployTrigger is "webhook"; the secret never leaves the server here. */
  webhook: ProjectWebhookState | null;
  sourceType: "github" | "upload";
  nginxExtraConfig: string | null;
  nginxExtraBlocks: string | null;
  composeFile: string | null;
  availableComposeFiles: string[];
  createdAt: string;
  updatedAt: string;
}

export const DEPLOY_TRIGGERS = ["poller", "webhook", "manual"] as const;
export type DeployTrigger = (typeof DEPLOY_TRIGGERS)[number];

export function parseDeployTrigger(value: unknown): DeployTrigger {
  return (DEPLOY_TRIGGERS as readonly unknown[]).includes(value) ? (value as DeployTrigger) : "poller";
}

/** waiting: no signed delivery yet · verified: last signed delivery was handled · failing: GitHub reports errors or install failed */
export type HookStatus = "waiting" | "verified" | "failing";

export interface ProjectWebhookState {
  installedOnGithub: boolean;
  status: HookStatus;
  lastDeliveryAt: string | null;
}

function parseHookStatus(value: unknown): HookStatus {
  return value === "verified" || value === "failing" ? value : "waiting";
}

export interface ProjectRow {
  group_name: string | null;
  id: number;
  name: string;
  url: string | null;
  internal_port: number | null;
  health_check_url: string | null;
  health_check_endpoint: string | null;
  health_check_domain_id: number | null;
  health_check_interval_s: number;
  last_status: string;
  last_response_ms: number | null;
  last_checked_at: string | null;
  github_repo: string | null;
  credential_id: number | null;
  github_credential_id: number | null;
  paused: number;
  favorite: number;
  auto_deploy_branch: string | null;
  last_commit_sha: string | null;
  last_commit_message: string | null;
  last_commit_author: string | null;
  last_commit_at: string | null;
  branches_json: string | null;
  branches_fetched_at?: string | null;
  deploy_trigger?: string | null;
  pending_deploy_sha?: string | null;
  github_checked_at?: string | null;
  github_check_error?: string | null;
  hook_public_id?: string | null;
  hook_secret_enc?: string | null;
  github_hook_id?: number | null;
  hook_status?: string | null;
  hook_last_delivery_at?: string | null;
  source_type: string;
  nginx_extra_config: string | null;
  nginx_extra_blocks: string | null;
  compose_file: string | null;
  available_compose_files: string | null;
  created_at: string;
  updated_at: string;
}

export function rowToProject(row: ProjectRow): Project {
  const validStatus = ["up", "down", "unknown"];
  return {
    groupName: row.group_name ?? null,
    id: row.id,
    name: row.name,
    internalPort: row.internal_port,
    healthCheckEndpoint: row.health_check_endpoint,
    healthCheckDomainId: row.health_check_domain_id,
    healthCheckIntervalS: row.health_check_interval_s,
    lastStatus: (validStatus.includes(row.last_status) ? row.last_status : "unknown") as
      | "up"
      | "down"
      | "unknown",
    lastResponseMs: row.last_response_ms,
    lastCheckedAt: row.last_checked_at,
    githubRepo: row.github_repo,
    credentialId: row.credential_id,
    githubCredentialId: row.github_credential_id,
    paused: !!row.paused,
    favorite: !!row.favorite,
    autoDeployBranch: row.auto_deploy_branch ?? null,
    lastCommitSha: row.last_commit_sha ?? null,
    lastCommitMessage: row.last_commit_message ?? null,
    lastCommitAuthor: row.last_commit_author ?? null,
    lastCommitAt: row.last_commit_at ?? null,
    branches: parseBranchesJson(row.branches_json),
    branchesFetchedAt: row.branches_fetched_at ?? null,
    deployTrigger: parseDeployTrigger(row.deploy_trigger),
    pendingDeploySha: row.pending_deploy_sha ?? null,
    githubCheckedAt: row.github_checked_at ?? null,
    githubCheckError: row.github_check_error ?? null,
    webhook: row.hook_public_id
      ? {
          installedOnGithub: row.github_hook_id != null,
          status: parseHookStatus(row.hook_status),
          lastDeliveryAt: row.hook_last_delivery_at ?? null,
        }
      : null,
    sourceType: row.source_type === "upload" ? "upload" : "github",
    nginxExtraConfig: row.nginx_extra_config ?? null,
    nginxExtraBlocks: row.nginx_extra_blocks ?? null,
    composeFile: row.compose_file ?? null,
    availableComposeFiles: parseStringArrayJson(row.available_compose_files),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseBranchesJson(json: string | null): ProjectBranch[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as ProjectBranch[];
  } catch {
    return [];
  }
}

function parseStringArrayJson(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
