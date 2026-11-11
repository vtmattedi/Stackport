import { useState } from "react";
import { Link } from "react-router-dom";
import { Plug } from "lucide-react";
import { ExpandableCard } from "../../components/ExpandableCard";
import { Button } from "../../components/ui/button";
import { api, ApiError } from "../../api/client";
import type { Project } from "../../api/types";
import { notify } from "../../lib/notify";

/** How this project reaches GitHub: with a token, or through the GitHub App. Moving to the App first proves, with a
 *  real call, that it can read the repository, and keeps the token so moving back loses nothing. */
export function GithubAuthCard({ project, setProject }: { project: Project; setProject: (next: Project) => void }) {
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState("");
  if (project.sourceType !== "github" || !project.githubRepo) return null;
  const usesApp = project.githubAuthMode === "app";

  async function move(mode: "app" | "token") {
    setSaving(true);
    setProblem("");
    try {
      const result = await api.setProjectGithubAuth(project.id, { mode });
      setProject({ ...project, githubAuthMode: result.githubAuthMode });
      notify.success(mode === "app" ? "This project now uses the GitHub App." : "This project uses its token again.");
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "Could not change how this project reaches GitHub");
    } finally {
      setSaving(false);
    }
  }

  return (
    <ExpandableCard icon={<Plug size={13} />} title="GitHub access" storageKey="project.github-auth" summary={<span>{usesApp ? "GitHub App" : "Token"}</span>}>
      {usesApp ? (
        <>
          <p className="hint">
            Deploys and branch checks use a short-lived token from the GitHub App (<Link to="/settings/github">Settings &gt; GitHub</Link>). If the App
            loses access to <code className="mono">{project.githubRepo}</code>, they fail with a message: they do not fall back to a token.
          </p>
          <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => void move("token")}>Use this project's token again</Button>
        </>
      ) : (
        <>
          <p className="hint">
            This project reaches <code className="mono">{project.githubRepo}</code> with a token. The GitHub App replaces it with short-lived tokens
            that Stackport requests itself. The token stays on the project, so you can move back.
          </p>
          <Button type="button" size="sm" disabled={saving} onClick={() => void move("app")}>Use the GitHub App</Button>
        </>
      )}
      {problem && <p role="alert" className="hint"><strong>{problem}</strong></p>}
    </ExpandableCard>
  );
}
