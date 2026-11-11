import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Network } from "lucide-react";
import { ExpandableCard } from "../../components/ExpandableCard";
import { Switch } from "../../components/ui/switch";
import { api } from "../../api/client";
import type { IngressIsolationResult, Project } from "../../api/types";
import { notify } from "../../lib/notify";
import styles from "../ProjectDetails.module.scss";

/** Per-project switch for a network of the project's own. The change is made while the request waits: nginx's
 *  config only changes after the new route has been seen working from inside nginx, and everything is put back
 *  if it cannot be, so the steps that were taken are shown either way. */
export function IsolationCard({ project, setProject }: { project: Project; setProject: (next: Project) => void }) {
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<IngressIsolationResult | null>(null);
  const queryClient = useQueryClient();

  async function toggle(enabled: boolean) {
    setSaving(true);
    setResult(null);
    try {
      const outcome = await api.setProjectIngressIsolation(project.id, enabled);
      setResult(outcome);
      setProject({ ...project, ingressIsolated: outcome.isolated });
      if (outcome.ok) notify.success(enabled ? "The project is on its own network." : "The project is back on the shared network.");
      else notify.error(new Error(outcome.reason ?? "The change was not made"), "Nothing was changed");
      void queryClient.invalidateQueries({ queryKey: ["project", project.id] });
    } catch (err) {
      notify.error(err, "Could not change the project's network");
    } finally {
      setSaving(false);
    }
  }

  return (
    <ExpandableCard
      icon={<Network size={13} />}
      title="Network isolation"
      storageKey="project.isolation"
      summary={<span>{project.ingressIsolated ? "Own network" : "Shared network"}</span>}
    >
      <label className={styles.switchField}>
        <Switch checked={project.ingressIsolated} disabled={saving} onCheckedChange={(value) => void toggle(value)} />
        <span>
          <span>Give this project's routed services a network of their own</span>
          <span>
            By default every routed service, of every project, shares one network with nginx, so one project's services can
            reach another's. With this on, only nginx and this project's routed services are on the network. The project must
            be running: the new route is checked from nginx before anything is switched, and nothing is changed if it does
            not work. It does not use Docker's small default address pool.
          </span>
        </span>
      </label>
      {result && (
        <div role="status" className="hint">
          {result.reason && <p><strong>{result.reason}</strong></p>}
          <ul>
            {result.steps.map((step, i) => <li key={i}>{step}</li>)}
          </ul>
        </div>
      )}
    </ExpandableCard>
  );
}
