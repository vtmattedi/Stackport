import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import type { GithubSettings } from "../../api/types";

export interface AppRepositoryChoice { installationId: number; repositoryId: number; fullName: string }

interface RepositoryRow { repositoryId: number; installationId: number; fullName: string; isPrivate: boolean }

/** Lists the repositories the GitHub App can use, grouped by the account that installed it. Picking one binds the new
 *  project to that repository by id: no token is typed or stored. */
export function GithubAppRepositoryPicker({ value, onChange, disabled }: {
  value: { installationId: number; repositoryId: number } | null;
  onChange: (choice: AppRepositoryChoice | null) => void;
  disabled?: boolean;
}) {
  const [settings, setSettings] = useState<GithubSettings | null>(null);
  const [repositories, setRepositories] = useState<RepositoryRow[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    Promise.all([api.getGithubSettings(), api.getGithubRepositories()])
      .then(([nextSettings, nextRepositories]) => { if (live) { setSettings(nextSettings); setRepositories(nextRepositories.repositories); } })
      .catch(() => { if (live) setError("Could not read the GitHub App's repositories."); });
    return () => { live = false; };
  }, []);

  if (error) return <div className="muted-text">{error}</div>;
  if (!settings) return <div className="muted-text">Loading repositories...</div>;
  const linked = settings.installations.filter((i) => i.status === "linked");
  if (!settings.app || linked.length === 0) {
    return <div className="muted-text">No GitHub account is connected yet. Set it up in <Link to="/settings/github">Settings &gt; GitHub</Link>.</div>;
  }

  const selected = value ? `${value.installationId}:${value.repositoryId}` : "";
  return (
    <select
      value={selected}
      disabled={disabled}
      required
      onChange={(event) => {
        const [installationId, repositoryId] = event.target.value.split(":").map(Number);
        const repository = repositories.find((r) => r.installationId === installationId && r.repositoryId === repositoryId);
        onChange(repository ? { installationId, repositoryId, fullName: repository.fullName } : null);
      }}
    >
      <option value="">Choose a repository</option>
      {linked.map((installation) => (
        <optgroup key={installation.installationId} label={installation.accountLogin}>
          {repositories.filter((r) => r.installationId === installation.installationId).map((r) => (
            <option key={r.repositoryId} value={`${r.installationId}:${r.repositoryId}`}>{r.fullName}{r.isPrivate ? " (private)" : ""}</option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
