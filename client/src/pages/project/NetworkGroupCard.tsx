import { useEffect, useState } from "react";
import { Loader, Network, Save } from "lucide-react";
import { ExpandableCard } from "../../components/ExpandableCard";
import { Button } from "../../components/ui/button";
import { Switch } from "../../components/ui/switch";
import { api } from "../../api/client";
import type { NetworkGroupView, Project } from "../../api/types";
import { notify } from "../../lib/notify";
import styles from "../ProjectDetails.module.scss";

/** Lets the project's services be reached by other projects in the same network group, by a
 *  hostname that carries the project's id (`db.p7`). Separate from the project list's grouping:
 *  nothing is shared until a service is switched on here. */
export function NetworkGroupCard({ project }: { project: Project }) {
  const [view, setView] = useState<NetworkGroupView | null>(null);
  const [group, setGroup] = useState("");
  const [services, setServices] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  function load(next: NetworkGroupView) {
    setView(next);
    setGroup(next.group ?? "");
    setServices(next.services);
  }

  useEffect(() => {
    let cancelled = false;
    api.getProjectNetworkGroup(project.id).then((next) => { if (!cancelled) load(next); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [project.id]);

  const changed = view !== null && (group.trim().toLowerCase() !== (view.group ?? "") || services.join() !== view.services.join());

  async function save() {
    setSaving(true);
    try {
      const next = await api.setProjectNetworkGroup(project.id, group, services);
      load(next);
      if (next.applied === false) notify.error(new Error(next.warning ?? "Docker could not be reached"), "Saved, but could not be applied to the running containers. It applies on the next deploy");
      else notify.success(next.group ? "Network group saved" : "Left the network group");
    } catch (err) {
      notify.error(err, "Could not save the network group");
    } finally {
      setSaving(false);
    }
  }

  function toggle(service: string, on: boolean) {
    setServices((current) => (on ? [...new Set([...current, service])].sort() : current.filter((s) => s !== service)));
  }

  return (
    <ExpandableCard
      icon={<Network size={13} />}
      title="Network Group"
      storageKey="project.network-group"
      summary={<span>{view?.group ?? "None"}</span>}
      actions={(
        <Button type="button" size="xs" onClick={() => void save()} disabled={saving || !changed}>
          {saving ? <Loader size={12} className="spin" /> : <Save size={12} />}
          Save
        </Button>
      )}
    >
      <p className="muted-text">
        Projects in the same network group can reach each other&apos;s chosen services without going through a public domain.
        This is separate from the project list&apos;s grouping, and nothing is shared until you switch a service on.
      </p>
      <div className="field">
        <label>Group</label>
        <input type="text" placeholder="e.g. shop" value={group} maxLength={40} onChange={(e) => setGroup(e.target.value)} />
        <span className="hint">Lower-case letters, digits, - and _. Leave empty to leave the group.</span>
      </div>
      {group.trim() !== "" && (
        <div className="field">
          <label>Services other projects can reach</label>
          {view && view.availableServices.length === 0 && <span className="hint">No services found. Pull the project and select a Compose file first.</span>}
          {view?.availableServices.map((service) => (
            <label key={service} className={styles.switchField}>
              <Switch checked={services.includes(service)} disabled={saving} onCheckedChange={(on) => toggle(service, on)} />
              <span>
                <span className="mono">{service}</span>
                <span>Answers to <span className="mono">{service}.p{project.id}</span> for the projects in this group, and can reach theirs.</span>
              </span>
            </label>
          ))}
        </div>
      )}
      {view && view.peers.length > 0 && (
        <div className="field">
          <label>Other projects in this group</label>
          {view.peers.map((peer) => (
            <div key={peer.projectId} className="muted-text">
              {peer.name}: {peer.hostnames.length ? peer.hostnames.map((h) => h.hostname).join(", ") : "no services shared yet"}
            </div>
          ))}
        </div>
      )}
      <p className="muted-text">Changes apply to running containers straight away and again after each deploy. The services must be running to be reached.</p>
    </ExpandableCard>
  );
}
