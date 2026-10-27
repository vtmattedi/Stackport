import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  FolderDot,
  GitBranch,
  Loader,
  Plus,
  RefreshCw,
  Settings2,
  Star,
  Upload,
  Search,
} from "lucide-react";
import styles from "./Projects.module.scss";
import { ProjectPicker } from "../components/ProjectPicker";
import { useLocalStorageState } from "../hooks/useLocalStorageState";
import { Button } from "../components/ui/button";
import { NewProjectWizard } from "../components/project-wizard/NewProjectWizard";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { api } from "../api/client";
import type { Credential, Project } from "../api/types";
import { useSystem } from "../context/SystemContext";
import { deriveProjectStatus, explainProjectStatus, findProjectStack, projectStatusLabel, type ProjectStatusKind } from "../lib/projectStatus";
import { notify } from "../lib/notify";
import { cn } from "../lib/utils";
import { TimeAgo } from "../components/TimeAgo";

const STATUS_PILL_CLASS: Record<ProjectStatusKind, string> = {
  ready: styles.statusReady,
  down: styles.statusDown,
  problem: styles.statusWarn,
  "not-deployed": styles.statusIdle,
  paused: styles.statusWarn,
};

function StatusPill({ status, reason }: { status: ProjectStatusKind; reason: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn(styles.statusPill, STATUS_PILL_CLASS[status])} tabIndex={0}>
          <span className={styles.statusPillDot} />
          {projectStatusLabel(status)}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{reason}</TooltipContent>
    </Tooltip>
  );
}

function githubTokenLabel(project: Project, githubCredentials: Credential[]): string {
  if (project.githubCredentialId) {
    const credential = githubCredentials.find((item) => item.id === project.githubCredentialId);
    return credential ? `GitHub token: ${credential.alias}` : `GitHub token: #${project.githubCredentialId}`;
  }
  const defaultCredential = githubCredentials.find((item) => item.isDefault);
  return defaultCredential ? `GitHub token: ${defaultCredential.alias} (default)` : "No GitHub token selected";
}

export default function Projects() {
  const { projects: projectsData, refreshProjects: refresh, startProjectAction, system } = useSystem();
  const projects = projectsData ?? [];
  const loading = projectsData === null;
  const [scope, setScope] = useLocalStorageState<string[]>("projects-scope", []);
  const scopeItems = useMemo(() => projects.map(project => ({ value: String(project.id), label: project.name, group: project.groupName })), [projects]);
  const scopeIds = new Set(scope.filter(id => scopeItems.some(item => item.value === id)));
  const [search, setSearch] = useState("");
  const searchTerm = search.trim().toLowerCase();
  const visibleProjects = projects
    .filter(project => scopeIds.size === 0 || scopeIds.has(String(project.id)))
    .filter(project => !searchTerm
      || project.name.toLowerCase().includes(searchTerm)
      || (project.githubRepo ?? "").toLowerCase().includes(searchTerm)
      || (project.domains ?? []).some(domain => domain.domain.toLowerCase().includes(searchTerm)));
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const githubCredentials = credentials.filter((credential) => credential.type === "github");
  const [togglingFavoriteId, setTogglingFavoriteId] = useState<number | null>(null);
  const [redeployingIds, setRedeployingIds] = useState<ReadonlySet<number>>(new Set());

  /** Row Redeploy: the same action as the project page's Redeploy (or Rebuild for uploads),
   *  tracked by the shared action toast so the list stays usable meanwhile. */
  async function redeployFromList(p: Project) {
    setRedeployingIds((ids) => new Set(ids).add(p.id));
    try {
      await startProjectAction(p.id, p.sourceType === "upload" ? "build" : "deploy");
    } finally {
      setRedeployingIds((ids) => { const next = new Set(ids); next.delete(p.id); return next; });
      refresh();
    }
  }

  async function toggleFavorite(p: Project) {
    setTogglingFavoriteId(p.id);
    try {
      if (p.favorite) await api.unfavoriteProject(p.id);
      else await api.favoriteProject(p.id);
      refresh();
    } catch (err) {
      notify.error(err, p.favorite ? `Failed to unfavorite ${p.name}` : `Failed to favorite ${p.name}`);
    } finally {
      setTogglingFavoriteId(null);
    }
  }

  const [wizard, setWizard] = useState<{ key: number; resume: Project | null } | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();

  useEffect(() => {
    void api.listCredentials().then(setCredentials);
  }, []);

  function openWizard(resume: Project | null = null) {
    setWizard((current) => ({ key: (current?.key ?? 0) + 1, resume }));
  }

  function closeWizard() {
    setWizard(null);
    refresh();
  }

  // `/projects?setup=<id>` reopens the wizard for a project whose setup was left unfinished.
  const setupId = Number(searchParams.get("setup"));
  const setupProject = setupId ? projects.find((project) => project.id === setupId) ?? null : null;
  useEffect(() => {
    if (!setupProject) return;
    openWizard(setupProject);
    setSearchParams((params) => { params.delete("setup"); return params; }, { replace: true });
  }, [setupProject, setSearchParams]);

  return (
    <>
      <main className="main">
        <div className="page-title" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}><FolderDot size={20} />Projects</span>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => openWizard()}>
            <Plus size={14} />
            Add new project
          </button>
        </div>

        <TooltipProvider>
          <div className="card">
            <div className={styles.listToolbar}>
              <label className={styles.searchBox}>
                <Search size={13} />
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by name, repo or domain"
                  aria-label="Search projects"
                />
              </label>
              <ProjectPicker items={scopeItems} selected={scope} onChange={setScope} align="end" />
            </div>
            {loading ? (
              <div className="empty">Loading...</div>
            ) : visibleProjects.length === 0 ? (
              <div className="empty">{!projects.length ? "No projects yet." : searchTerm ? `No projects match "${search.trim()}".` : "No projects in this selection."}</div>
            ) : (
              <div className="table-wrap">
                <table className={styles.projectTable}>
                  <thead>
                    <tr>
                      <th>Project</th>
                      <th>Status</th>
                      <th>Deployed commit</th>
                      <th>Domain</th>
                      <th><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleProjects.map((p) => {
                      const tokenLabel = githubTokenLabel(p, githubCredentials);
                      const dockerAvailable = system?.docker?.available ?? false;
                      const pDockerStack = system?.docker ? findProjectStack(p, system.docker.stacks) : null;
                      const pStatus = deriveProjectStatus(p, pDockerStack, dockerAvailable);
                      const pStatusReason = explainProjectStatus(p, pDockerStack, dockerAvailable, pStatus);
                      const isGithub = p.sourceType !== "upload" && !!p.githubRepo;
                      const canRebuild = isGithub || p.sourceType === "upload";
                      return (
                        <tr key={p.id}>
                          <td data-label="Project">
                            <div className={styles.nameCell}>
                              <button
                                type="button"
                                className="btn-icon"
                                aria-label={p.favorite ? `Unfavorite ${p.name}` : `Favorite ${p.name}`}
                                disabled={togglingFavoriteId === p.id}
                                onClick={(e) => { e.preventDefault(); e.stopPropagation(); void toggleFavorite(p); }}
                              >
                                <Star
                                  size={14}
                                  fill={p.favorite ? "currentColor" : "none"}
                                  style={p.favorite ? { color: "var(--brand)" } : undefined}
                                />
                              </button>
                              <div className={styles.nameStack}>
                                <Link className={cn("ext-link", styles.projectName)} to={`/projects/${p.id}`}>{p.name}</Link>
                                <span className={styles.subLine}>
                                  {p.githubRepo ? (
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <span className={styles.repo} tabIndex={0} aria-label={`${p.githubRepo}, ${tokenLabel}`}>
                                          <GitBranch size={11} />
                                          <span className="mono">{p.githubRepo}</span>
                                        </span>
                                      </TooltipTrigger>
                                      <TooltipContent side="top">{tokenLabel}</TooltipContent>
                                    </Tooltip>
                                  ) : p.sourceType === "upload" ? (
                                    <span className={styles.repo}><Upload size={11} />Uploaded files</span>
                                  ) : <span>No source set</span>}
                                  {p.groupName && <span>· {p.groupName}</span>}
                                </span>
                              </div>
                            </div>
                          </td>
                          <td data-label="Status">
                            <StatusPill status={pStatus} reason={pStatusReason} />
                          </td>
                          <td data-label="Deployed">
                            {p.lastCommitSha ? (
                              <div className={styles.commitCell}>
                                <span>
                                  <span className="mono">{p.lastCommitSha.slice(0, 7)}</span>
                                  {p.lastCommitMessage && <span className={styles.commitMessage} title={p.lastCommitMessage}> {p.lastCommitMessage}</span>}
                                </span>
                                {p.lastCommitAt && <span className={styles.subLine}><TimeAgo ts={p.lastCommitAt} />{p.lastCommitAuthor ? ` · ${p.lastCommitAuthor}` : ""}</span>}
                              </div>
                            ) : <span className="muted-text">{p.sourceType === "upload" ? "Uploaded" : "Not deployed yet"}</span>}
                          </td>
                          <td data-label="Domain">
                            {(p.domains?.length ?? 0) > 0 ? (
                              <span className="url-row">
                                <a
                                  className="ext-link mono"
                                  href={`${p.domains![0].useSsl ? "https" : "http"}://${p.domains![0].domain}`}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {p.domains![0].domain}
                                </a>
                                {p.domains!.length > 1 && (
                                  <span className="muted-text" style={{ fontSize: "0.85em" }}>+{p.domains!.length - 1} more</span>
                                )}
                              </span>
                            ) : <span className="muted-text">No domain</span>}
                          </td>
                          <td className={styles.actionsCell}>
                            {pStatus === "not-deployed" && (p.domains?.length ?? 0) === 0 && (
                              <Button type="button" variant="outline" size="xs" onClick={() => openWizard(p)} title="Pick up the setup wizard where it stopped">
                                <Settings2 size={12} />
                                Finish setup
                              </Button>
                            )}
                            {canRebuild && (
                              <Button
                                type="button"
                                variant="outline"
                                size="xs"
                                onClick={() => void redeployFromList(p)}
                                disabled={p.paused || redeployingIds.has(p.id)}
                                title={p.paused ? "Resume the project to deploy it"
                                  : isGithub ? "Pull the checked-out branch, then rebuild and restart"
                                  : "Rebuild and restart from the uploaded files"}
                              >
                                {redeployingIds.has(p.id) ? <Loader size={12} className="spin" /> : <RefreshCw size={12} />}
                                {isGithub ? "Redeploy" : "Rebuild"}
                              </Button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </TooltipProvider>
      </main>

      {wizard && (
        <NewProjectWizard
          key={wizard.key}
          projects={projects}
          credentials={credentials}
          resumeProject={wizard.resume}
          onClose={closeWizard}
        />
      )}
    </>
  );
}
