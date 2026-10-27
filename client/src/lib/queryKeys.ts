/** Every query key in one place, so invalidation can't miss a spelling. */
export const queryKeys = {
  runningActions: ["actions", "running"] as const,
  action: (id: string) => ["actions", id] as const,
  projects: ["projects"] as const,
  project: (id: number) => ["project", id] as const,
  projectDeploys: (id: number) => ["project", id, "deploys"] as const,
  projectRevisions: (id: number) => ["project", id, "revisions"] as const,
  projectActions: (id: number) => ["project", id, "actions"] as const,
  system: ["system"] as const,
  systemActions: ["system", "actions"] as const,
  vps: ["vps"] as const,
  githubPoller: ["github-poller"] as const,
  apiTokens: ["api-tokens"] as const,
};
