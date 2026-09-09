export interface ProjectBranch {
  name: string;
  sha: string;
  commitMessage: string | null;
  commitAuthor: string | null;
  commitAt: string | null;
}

export interface Project {
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
  branches: ProjectBranch[];
  sourceType: "github" | "upload";
  nginxExtraConfig: string | null;
  nginxExtraBlocks: string | null;
  composeFile: string | null;
  availableComposeFiles: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRow {
  id: number;
  name: string;
  url: string | null;
  internal_port: number | null;
  health_check_url: string | null;
  health_check_endpoint: string | null;
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
    id: row.id,
    name: row.name,
    internalPort: row.internal_port,
    healthCheckEndpoint: row.health_check_endpoint,
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
