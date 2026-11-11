import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, CheckCircle, Loader } from "lucide-react";
import { api, ApiError } from "../../api/client";
import type { GithubRepositoryInspection, Project } from "../../api/types";
import { Combobox, type ComboboxOption } from "../Combobox";
import { Badge } from "../ui/badge";
import { Field } from "../ui/field";
import { Hint } from "../ui/text";
import type { AppRepository, GithubRepositories } from "./useGithubRepositories";

export interface AppRepositoryChoice { installationId: number; repositoryId: number; fullName: string }

const key = (repository: { installationId: number; repositoryId: number }): string => `${repository.installationId}:${repository.repositoryId}`;

/** What the chosen repository holds on its default branch, read from GitHub before anything is cloned: Compose files and the variables a
 *  .env.example asks for. It is information, not a gate: the branch can be changed in the next step. */
function RepositoryCheck({ repository }: { repository: AppRepository }) {
  const [result, setResult] = useState<{ inspection: GithubRepositoryInspection } | { error: string } | null>(null);
  const branch = repository.defaultBranch;

  useEffect(() => {
    setResult(null);
    if (!branch) return;
    let live = true;
    api.inspectGithubRepository(repository.installationId, repository.repositoryId, branch)
      .then((inspection) => { if (live) setResult({ inspection }); })
      .catch((err: unknown) => { if (live) setResult({ error: err instanceof ApiError ? err.message : "Could not look inside the repository." }); });
    return () => { live = false; };
  }, [repository.installationId, repository.repositoryId, branch]);

  if (!branch) return <Hint>This repository has no default branch yet (it is empty). Push something to it first.</Hint>;
  if (!result) return <Hint className="flex items-center gap-2"><Loader size={12} className="spin" />Looking at <span className="mono">{branch}</span>…</Hint>;
  if ("error" in result) return <Hint className="flex items-center gap-2"><AlertTriangle size={12} />{result.error} You can still continue; the files are checked when they are fetched.</Hint>;

  const { composeFiles, envVariableNames, truncated } = result.inspection;
  if (composeFiles.length === 0) {
    return (
      <div className="flex items-start gap-2 text-xs text-[var(--warning,#d29922)]">
        <AlertTriangle size={13} className="mt-0.5 shrink-0" />
        <span>No Compose file found on <span className="mono">{branch}</span>{truncated ? " (the repository is large, so GitHub's file list was cut short)" : ""}. Stackport deploys Compose projects: pick another repository, or choose another branch in the next step.</span>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2 text-xs text-[var(--success)]">
      <CheckCircle size={13} className="mt-0.5 shrink-0" />
      <span>
        <span className="mono">{branch}</span> has {composeFiles.length === 1 ? "a Compose file" : `${composeFiles.length} Compose files`}: <span className="mono">{composeFiles.slice(0, 3).join(", ")}{composeFiles.length > 3 ? ", …" : ""}</span>.
        {envVariableNames.length > 0 && <> Its <span className="mono">.env.example</span> lists {envVariableNames.length} {envVariableNames.length === 1 ? "variable" : "variables"} to set.</>}
      </span>
    </div>
  );
}

/** Picks one of the repositories the GitHub App can use: every account it is installed on, searchable, with what each repository is and
 *  whether it is already a project. Binds the new project to the repository by id, so no token is typed or stored. */
export function GithubRepositoryField({ github, projects, value, onChange, disabled }: {
  github: GithubRepositories;
  projects: Project[];
  value: { installationId: number; repositoryId: number } | null;
  onChange: (choice: AppRepositoryChoice | null) => void;
  disabled?: boolean;
}) {
  const accounts = useMemo(() => new Map((github.settings?.installations ?? []).map((installation) => [installation.installationId, installation.accountLogin])), [github.settings]);
  const usedBy = useMemo(() => new Map(projects.filter((project) => project.githubAuthMode === "app" && project.githubRepo).map((project) => [project.githubRepo!.toLowerCase(), project.name])), [projects]);

  const options: ComboboxOption[] = useMemo(() => github.repositories
    .filter((repository) => accounts.has(repository.installationId))
    .map((repository) => {
      const project = usedBy.get(repository.fullName.toLowerCase());
      return {
        value: key(repository),
        label: repository.fullName,
        description: project ? `Already the project "${project}"` : repository.defaultBranch ? `Default branch ${repository.defaultBranch}` : "Empty repository",
        group: accounts.get(repository.installationId),
        badges: repository.isPrivate ? <Badge variant="outline">private</Badge> : undefined,
      };
    }), [github.repositories, accounts, usedBy]);

  const selected = value ? github.repositories.find((repository) => key(repository) === key(value)) ?? null : null;

  if (github.loading) return <Hint className="flex items-center gap-2"><Loader size={12} className="spin" />Reading the repositories the GitHub App can use…</Hint>;
  if (github.error) return <Hint>{github.error}</Hint>;
  if (!github.appReady) return <Hint>No GitHub account is connected yet. Set it up in <Link to="/settings/github">Settings &gt; GitHub</Link>.</Hint>;

  return (
    <div className="grid gap-3">
      <Field label="Repository" htmlFor="wizard-repository" hint={`${options.length} ${options.length === 1 ? "repository" : "repositories"} across ${accounts.size} ${accounts.size === 1 ? "account" : "accounts"}. Missing one? Give the App access to it on GitHub, then refresh the account in Settings > GitHub.`}>
        <Combobox
          id="wizard-repository"
          value={value ? key(value) : ""}
          onValueChange={(next) => {
            const repository = github.repositories.find((candidate) => key(candidate) === next);
            onChange(repository ? { installationId: repository.installationId, repositoryId: repository.repositoryId, fullName: repository.fullName } : null);
          }}
          options={options}
          placeholder="Choose a repository"
          searchPlaceholder="Search by owner or name"
          emptyText="No repository matches."
          disabled={disabled}
        />
      </Field>
      {selected && <RepositoryCheck repository={selected} />}
    </div>
  );
}
