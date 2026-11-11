import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertCircle, Check, Loader, X } from "lucide-react";
import { api, ApiError } from "../../api/client";
import type { ProjectEnforcement } from "../../api/types";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { notify } from "../../lib/notify";

function Flag({ on }: { on: boolean }) {
  return on
    ? <span style={{ color: "var(--ok, #2e9d5b)" }} title="On"><Check size={14} aria-label="On" /></span>
    : <span style={{ color: "var(--warn, #c77d00)" }} title="Off"><X size={14} aria-label="Off" /></span>;
}

/** Which projects still lack a 1.3 protection. Projects that existed before 1.3 keep the old
 *  behaviour until someone switches them, so this is the list to work through. */
export default function EnforcementSection() {
  const [projects, setProjects] = useState<ProjectEnforcement[] | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(() => {
    api.getProjectEnforcement()
      .then((result) => setProjects(result.projects))
      .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load the projects"));
  }, []);
  useEffect(load, [load]);

  async function enforce(project: ProjectEnforcement) {
    setBusyId(project.id);
    try {
      await api.setProjectComposePolicyEnforcement(project.id, true);
      notify.success(`${project.name}: Compose policy enforced. It applies on its next deploy.`);
      load();
    } catch (err) {
      notify.error(err, "Could not enforce the Compose policy");
    } finally {
      setBusyId(null);
    }
  }

  if (error) return <Alert variant="destructive"><AlertCircle size={14} /><AlertDescription>{error}</AlertDescription></Alert>;
  if (!projects) return <Loader size={14} className="spin" />;

  const incomplete = projects.filter((p) => !p.composePolicyEnforced || !p.volumesManaged || !p.hardenedDefaults);
  return (
    <div className="card">
      <p className="hint">
        New projects start with every protection on. A project created before 1.3 keeps its old behaviour until you switch
        it. Enforcing the policy and hardened defaults are per-project switches on the project's Settings tab. Managed
        volumes apply to new projects only: the page that copied an older project's data over was removed in 1.3.9, so
        a project that still lists them as off keeps its current mounts.
      </p>
      {incomplete.length === 0 ? (
        <p>Every project has all three protections on.</p>
      ) : (
        <table>
          <thead>
            <tr><th>Project</th><th>Compose policy</th><th>Managed volumes</th><th>Hardened defaults</th><th /></tr>
          </thead>
          <tbody>
            {incomplete.map((project) => (
              <tr key={project.id}>
                <td><Link to={`/projects/${project.id}/settings`}>{project.name}</Link></td>
                <td><Flag on={project.composePolicyEnforced} /></td>
                <td><Flag on={project.volumesManaged} /></td>
                <td><Flag on={project.hardenedDefaults} /></td>
                <td>
                  {!project.composePolicyEnforced && (
                    <Button type="button" size="sm" disabled={busyId === project.id} onClick={() => void enforce(project)}>
                      {busyId === project.id ? <Loader size={14} className="spin" /> : null} Enforce policy
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
