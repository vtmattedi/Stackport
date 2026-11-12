import { useEffect, useState } from "react";
import { api } from "../../api/client";
import type { GithubSettings } from "../../api/types";

export interface AppRepository {
  repositoryId: number;
  installationId: number;
  fullName: string;
  defaultBranch: string | null;
  isPrivate: boolean;
}

export interface GithubRepositories {
  /** The settings and the repository list are still being read. */
  loading: boolean;
  /** An App is registered and at least one account is connected, so its repositories can be listed. */
  appReady: boolean;
  /** Why the list could not be read, when it could not. */
  error: string;
  settings: GithubSettings | null;
  repositories: AppRepository[];
}

/** What the GitHub App can reach: the connected accounts and every repository the App was given. Read once when the wizard opens. */
export function useGithubRepositories(): GithubRepositories {
  const [state, setState] = useState<GithubRepositories>({ loading: true, appReady: false, error: "", settings: null, repositories: [] });

  useEffect(() => {
    let live = true;
    Promise.all([api.getGithubSettings(), api.getGithubRepositories()])
      .then(([settings, { repositories }]) => {
        if (!live) return;
        const linked = settings.installations.some((installation) => installation.status === "linked");
        setState({ loading: false, appReady: !!settings.app && linked, error: "", settings, repositories });
      })
      .catch(() => { if (live) setState({ loading: false, appReady: false, error: "Could not read the GitHub App's repositories.", settings: null, repositories: [] }); });
    return () => { live = false; };
  }, []);

  return state;
}
