import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight, FileText, FolderDot, GitBranch, Loader, RefreshCw, Save } from "lucide-react";
import { ActionSelect, AppSelect } from "../../components/AppSelect";
import { ComposeFileDialog } from "../../components/ComposeFileDialog";
import { ExpandableCard } from "../../components/ExpandableCard";
import { GitHubTokenSelect } from "../../components/GitHubTokenSelect";
import { NumberInput } from "../../components/NumberInput";
import { ProjectGroupField } from "../../components/ProjectGroupField";
import { Button } from "../../components/ui/button";
import { Switch } from "../../components/ui/switch";
import { api, ApiError } from "../../api/client";
import type { Credential, GitHubBranch, Project, ProjectDomain } from "../../api/types";
import { useSystemActions, useSystemSelector } from "../../context/SystemContext";
import { formatShortDateTime } from "../../lib/format";
import { notify } from "../../lib/notify";
import { cn } from "../../lib/utils";
import styles from "../ProjectDetails.module.scss";
import { DetailRow } from "./shared";

const INTERVALS = [
  { label: "Off", value: 0 },
  { label: "30 s", value: 30 },
  { label: "1 min", value: 60 },
  { label: "5 min", value: 300 },
  { label: "15 min", value: 900 },
  { label: "30 min", value: 1800 },
  { label: "1 hr", value: 3600 },
];

/** A collapsible group inside the Project Config form; open state is remembered per section. */
function ConfigSection({
  title,
  actions,
  storageKey,
  defaultOpen = true,
  children,
}: {
  title: string;
  actions?: ReactNode;
  storageKey: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const key = `stackport:config-section:${storageKey}`;
  const [open, setOpen] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? defaultOpen : stored === "1";
    } catch {
      return defaultOpen;
    }
  });
  function toggle() {
    setOpen(!open);
    try {
      localStorage.setItem(key, open ? "0" : "1");
    } catch {
      // storage unavailable — state just won't persist
    }
  }
  return (
    <div className={cn(styles.runtimeSection, !open && styles.runtimeSectionCollapsed)}>
      <div className={styles.runtimeSectionHeader}>
        <button type="button" className={styles.sectionToggle} onClick={toggle} aria-expanded={open}>
          <ChevronRight size={12} className={cn(styles.sectionChevron, open && styles.sectionChevronOpen)} />
          {title}
        </button>
        {actions}
      </div>
      {open && children}
    </div>
  );
}


function sameProjectGroups(a: Project[] | null, b: Project[] | null): boolean {
  const key = (list: Project[] | null) => (list ?? []).map((p) => p.groupName ?? "").join("\u0000");
  return a === b || key(a) === key(b);
}


/**
 * The project's settings form (repository, Compose & nginx, health check) and its
 * metadata. Kept mounted while hidden, so unsaved edits survive switching tabs; the
 * form refills from new project data unless it has unsaved edits.
 */
export function SettingsTab({ project, setProject, domains, credentials, branches, loadingBranches, branchError, loadBranches, hidden }: {
  project: Project;
  setProject: (next: Project) => void;
  domains: ProjectDomain[];
  credentials: Credential[];
  branches: GitHubBranch[];
  loadingBranches: boolean;
  branchError: string;
  loadBranches: (refresh?: boolean) => Promise<void>;
  hidden: boolean;
}) {
  const { refreshProjects } = useSystemActions();
  // Only group names are used (for the group picker).
  const allProjects = useSystemSelector((snap) => snap.projects, sameProjectGroups);
  const [configHealthEndpoint, setConfigHealthEndpoint] = useState("");
  const [configHealthDomainId, setConfigHealthDomainId] = useState<number | null>(null);
  const [configIntervalS, setConfigIntervalS] = useState(0);
  const [configHealthGraceS, setConfigHealthGraceS] = useState(60);
  const [configAutoRollback, setConfigAutoRollback] = useState(false);
  const [configComposeFile, setConfigComposeFile] = useState("");
  const [composeFileDialogOpen, setComposeFileDialogOpen] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [configError, setConfigError] = useState("");
  const [configAutoDeployBranch, setConfigAutoDeployBranch] = useState<string>("");
  const [configNginxExtra, setConfigNginxExtra] = useState("");
  const [configNginxExtraBlocks, setConfigNginxExtraBlocks] = useState("");
  const [configRepo, setConfigRepo] = useState("");
  const [configGroupName, setConfigGroupName] = useState("");
  const [configGithubCredentialId, setConfigGithubCredentialId] = useState<number | null>(null);
  /** The form was last synced from this version of the project: unsaved edits are
   *  measured against it, not against the newest push. */
  const [syncedProject, setSyncedProject] = useState<Project | null>(null);

  function syncConfig(projectData: Project) {
    setSyncedProject(projectData);
    setConfigRepo(projectData.githubRepo ?? "");
    setConfigGroupName(projectData.groupName ?? "");
    setConfigGithubCredentialId(projectData.githubCredentialId);
    setConfigComposeFile(projectData.composeFile ?? "");
    setConfigHealthEndpoint(projectData.healthCheckEndpoint ?? "");
    setConfigHealthDomainId(projectData.healthCheckDomainId);
    setConfigIntervalS(projectData.healthCheckIntervalS);
    setConfigHealthGraceS(projectData.deployHealthGraceS);
    setConfigAutoRollback(projectData.autoRollbackUnhealthy);
    setConfigAutoDeployBranch(projectData.autoDeployBranch ?? "");
    setConfigNginxExtra(projectData.nginxExtraConfig ?? "");
    setConfigNginxExtraBlocks(projectData.nginxExtraBlocks ?? "");
  }

  async function saveProjectConfig(e?: React.FormEvent) {
    e?.preventDefault();
    if (!project) return;
    const toastId = notify.loading("Saving project runtime settings...");
    setSavingConfig(true);
    setConfigError("");
    try {
      const updated = await api.updateProject(project.id, {
        groupName: configGroupName.trim() || null,
        githubRepo: configRepo || null,
        githubCredentialId: configGithubCredentialId,
        healthCheckEndpoint: configHealthEndpoint || null,
        healthCheckDomainId: configHealthDomainId,
        healthCheckIntervalS: configIntervalS,
        deployHealthGraceS: configHealthGraceS,
        autoRollbackUnhealthy: configAutoRollback,
        autoDeployBranch: configAutoDeployBranch || null,
        nginxExtraConfig: configNginxExtra.trim() || null,
        nginxExtraBlocks: configNginxExtraBlocks.trim() || null,
      });
      const withComposeFile = configComposeFile && configComposeFile !== (project.composeFile ?? "")
        ? await api.setProjectComposeFile(updated.id, configComposeFile)
        : updated;
      setProject(withComposeFile);
      syncConfig(withComposeFile);
      await refreshProjects();
      notify.success("Project runtime settings saved.", { id: toastId });
    } catch (err) {
      setConfigError(err instanceof ApiError ? err.message : "Failed to save project settings");
      notify.error(err, "Failed to save project runtime settings", { id: toastId });
    } finally {
      setSavingConfig(false);
    }
  }

  // Unsaved edits: the form differs from the project version it was filled from.
  const runtimeChanged = syncedProject ? (
    configGroupName.trim() !== (syncedProject.groupName ?? "") ||
    configRepo !== (syncedProject.githubRepo ?? "") ||
    configGithubCredentialId !== syncedProject.githubCredentialId ||
    configHealthEndpoint !== (syncedProject.healthCheckEndpoint ?? "") ||
    configHealthDomainId !== syncedProject.healthCheckDomainId ||
    configIntervalS !== syncedProject.healthCheckIntervalS ||
    configHealthGraceS !== syncedProject.deployHealthGraceS ||
    configAutoRollback !== syncedProject.autoRollbackUnhealthy ||
    configAutoDeployBranch !== (syncedProject.autoDeployBranch ?? "") ||
    configNginxExtra !== (syncedProject.nginxExtraConfig ?? "") ||
    configNginxExtraBlocks !== (syncedProject.nginxExtraBlocks ?? "") ||
    configComposeFile !== (syncedProject.composeFile ?? "")
  ) : false;
  const runtimeFormId = project ? `project-runtime-${project.id}` : "project-runtime";

  // New project data (a push, a save, a refetch) refills the form, unless the form
  // has unsaved edits relative to the version it was last filled from.
  useEffect(() => {
    if (project && !runtimeChanged) syncConfig(project);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  return (
    <div style={{ display: hidden ? "none" : "contents" }}>
        {/* ── Project config card ──────────────────────────────────── */}
        <ExpandableCard
          icon={<FileText size={13} />}
          title="Project Config"
          storageKey="project.config"
          className={styles.runtimeCard}
          summary={runtimeChanged ? <span className={styles.unsavedHint}>Unsaved changes</span> : undefined}
          actions={(
            <Button
              type="button"
              size="xs"
              onClick={() => void saveProjectConfig()}
              disabled={savingConfig || !runtimeChanged}
            >
              {savingConfig ? <Loader size={12} className="spin" /> : <Save size={12} />}
              Save
            </Button>
          )}
        >
          {configError && <div className="alert alert-error">{configError}</div>}

          <form id={runtimeFormId} className={styles.runtimeForm} onSubmit={(e) => void saveProjectConfig(e)}>
            <ProjectGroupField value={configGroupName} onValueChange={setConfigGroupName} projects={allProjects ?? []} disabled={savingConfig} />
            <ConfigSection title="Repository" storageKey="repository">
              <div className="field field-wide">
                <label>GitHub repo <span className="hint mono">(owner/repo)</span></label>
                <input type="text" value={configRepo} onChange={(e) => setConfigRepo(e.target.value)} />
              </div>
              <div className="field">
                <label>GitHub token</label>
                <GitHubTokenSelect
                  credentials={credentials}
                  value={configGithubCredentialId}
                  onValueChange={setConfigGithubCredentialId}
                />
              </div>
              <div className="field">
                <label>
                  <GitBranch size={12} />
                  Auto-deploy branch
                  <span className="hint"> (new commits here deploy automatically)</span>
                </label>
                <ActionSelect
                  value={configAutoDeployBranch}
                  onValueChange={setConfigAutoDeployBranch}
                  options={[
                    { value: "", label: "Off — no auto-deploy" },
                    ...branches.map((b) => ({
                      value: b.name,
                      label: b.name,
                    })),
                    ...(configAutoDeployBranch && !branches.some((b) => b.name === configAutoDeployBranch)
                      ? [{ value: configAutoDeployBranch, label: `Current: ${configAutoDeployBranch}` }]
                      : []),
                  ]}
                  action={(
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-sm"
                      onClick={() => void loadBranches()}
                      disabled={loadingBranches || !configRepo}
                      title="Fetch branches from GitHub"
                    >
                      {loadingBranches ? <Loader size={13} className="spin" /> : <RefreshCw size={13} />}
                    </Button>
                  )}
                />
                {branchError && <div style={{ fontSize: "0.78rem", color: "var(--danger)", marginTop: 4 }}>{branchError}</div>}
              </div>
            </ConfigSection>


            <ConfigSection title="Compose & Nginx" storageKey="compose-nginx" defaultOpen={false}>
              {(project.availableComposeFiles.length > 0 || project.composeFile) && (
                <div className="field">
                  <label>Compose file</label>
                  <ActionSelect
                    value={configComposeFile}
                    onValueChange={setConfigComposeFile}
                    options={[
                      ...project.availableComposeFiles.map((file) => ({ value: file, label: file })),
                      ...(project.composeFile && !project.availableComposeFiles.includes(project.composeFile)
                        ? [{ value: project.composeFile, label: project.composeFile }]
                        : []),
                    ]}
                    action={(
                      <Button
                        type="button"
                        variant="outline"
                        size="icon-sm"
                        onClick={() => setComposeFileDialogOpen(true)}
                        disabled={!project.composeFile}
                        title="View docker-compose.yml"
                      >
                        <FileText size={13} />
                      </Button>
                    )}
                  />
                </div>
              )}
              <div className="field field-wide" style={{ gridColumn: "1 / -1" }}>
                <label>
                  Extra Nginx config
                  <span className="hint"> (raw directives appended inside the proxy location block, e.g. client_max_body_size)</span>
                </label>
                <textarea
                  className="mono"
                  rows={4}
                  placeholder={"client_max_body_size 520M;\nclient_body_timeout 300s;\nproxy_read_timeout 300s;\nproxy_send_timeout 300s;"}
                  value={configNginxExtra}
                  onChange={(e) => setConfigNginxExtra(e.target.value)}
                />
              </div>
              <div className="field field-wide" style={{ gridColumn: "1 / -1" }}>
                <label>
                  Extra Nginx blocks <span className="hint">(HTTPS server only — raw blocks appended after the proxy location, e.g. an extra `location`. Use {"{{PORT}}"} for this project's internal port)</span>
                </label>
                <textarea
                  className="mono"
                  rows={6}
                  placeholder={'location /specific/url {\n    proxy_pass http://127.0.0.1:{{PORT}};\n    proxy_http_version 1.1;\n    proxy_set_header X-specific-route-only "das";\n\n    proxy_set_header Host $host;\n    proxy_set_header X-Real-IP $remote_addr;\n    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n    proxy_set_header X-Forwarded-Proto $scheme;\n}'}
                  value={configNginxExtraBlocks}
                  onChange={(e) => setConfigNginxExtraBlocks(e.target.value)}
                />
              </div>
            </ConfigSection>


            <ConfigSection title="Health check" storageKey="health-check">
              <div className="field">
                <label>Domain</label>
                <AppSelect
                  value={configHealthDomainId === null ? "" : String(configHealthDomainId)}
                  onValueChange={(value) => setConfigHealthDomainId(value ? Number(value) : null)}
                  disabled={domains.length === 0}
                  placeholder="Select a domain"
                  options={domains.length > 0
                    ? domains.map((domain) => ({
                        value: String(domain.id),
                        label: domain.useSsl ? domain.domain : `${domain.domain} (SSL off)`,
                      }))
                    : [{ value: "", label: "No domains available", disabled: true }]}
                />
              </div>
              <div className="field">
                <label>Path</label>
                <input type="text" placeholder="/health" value={configHealthEndpoint} onChange={(e) => setConfigHealthEndpoint(e.target.value)} />
              </div>
              <div className="field" style={{ minWidth: 120, flex: "none" }}>
                <label>Interval</label>
                <AppSelect
                  value={String(configIntervalS)}
                  onValueChange={(value) => setConfigIntervalS(Number(value))}
                  options={INTERVALS.map((interval) => ({
                    value: String(interval.value),
                    label: interval.label,
                  }))}
                />
              </div>
              <div className="field" style={{ minWidth: 140, flex: "none" }}>
                <label>After deploy <span className="hint">(wait up to)</span></label>
                <NumberInput
                  min={5}
                  max={600}
                  suffix="s"
                  aria-label="Seconds to wait for the health check after a deploy"
                  value={configHealthGraceS}
                  onValueChange={(seconds) => setConfigHealthGraceS(seconds ?? 60)}
                />
              </div>
              <div className="field">
                <label className={styles.switchField}>
                  <Switch checked={configAutoRollback} onCheckedChange={setConfigAutoRollback} />
                  <span>
                    <span>Roll back if unhealthy</span>
                    <span>
                      When a deploy's health check doesn't pass in time, restore the previous revision.
                      Otherwise the new revision keeps running and is marked unhealthy.
                    </span>
                  </span>
                </label>
              </div>
              {!configHealthEndpoint && (
                <p className="hint">Without a path, deploys aren't verified: a deploy counts as successful once its containers start.</p>
              )}
            </ConfigSection>
          </form>
        </ExpandableCard>

        <ExpandableCard
          icon={<FolderDot size={13} />}
          title="Project Metadata"
          storageKey="project.metadata"
          summary={<span className="mono" style={{ fontSize: 12 }}>#{project.id}</span>}
        >
          <div className={styles.detailGrid}>
            <DetailRow label="Project ID" value={<span className="mono">{project.id}</span>} />
            <DetailRow label="Created" value={<span className="mono">{formatShortDateTime(project.createdAt)}</span>} />
            <DetailRow label="Updated" value={<span className="mono">{formatShortDateTime(project.updatedAt)}</span>} />
          </div>
        </ExpandableCard>
      {composeFileDialogOpen && (
        <ComposeFileDialog projectId={project.id} projectName={project.name} onClose={() => setComposeFileDialogOpen(false)} />
      )}
    </div>
  );
}
