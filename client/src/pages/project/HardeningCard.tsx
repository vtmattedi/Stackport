import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { ExpandableCard } from "../../components/ExpandableCard";
import { Switch } from "../../components/ui/switch";
import { api } from "../../api/client";
import type { Project } from "../../api/types";
import { notify } from "../../lib/notify";
import styles from "../ProjectDetails.module.scss";

/** Per-project switch for the hardened container defaults (no-new-privileges, default
 *  memory and process limits). Saves on change; it applies on the next deploy. */
export function HardeningCard({ project, setProject }: { project: Project; setProject: (next: Project) => void }) {
  const [saving, setSaving] = useState(false);

  async function toggle(enabled: boolean) {
    setSaving(true);
    try {
      const result = await api.setProjectHardening(project.id, enabled);
      setProject({ ...project, hardenedDefaults: result.hardenedDefaults });
      notify.success(enabled ? "Hardened defaults on. They apply on the next deploy." : "Hardened defaults off. This applies on the next deploy.");
    } catch (err) {
      notify.error(err, "Could not change the hardened defaults");
    } finally {
      setSaving(false);
    }
  }

  return (
    <ExpandableCard
      icon={<ShieldCheck size={13} />}
      title="Container Hardening"
      storageKey="project.hardening"
      summary={<span>{project.hardenedDefaults ? "On" : "Off"}</span>}
    >
      <label className={styles.switchField}>
        <Switch checked={project.hardenedDefaults} disabled={saving} onCheckedChange={(value) => void toggle(value)} />
        <span>
          <span>Hardened defaults</span>
          <span>
            Every service gets no-new-privileges, and a memory and process limit when its Compose file sets none.
            Turn this off for a service that needs more than the defaults allow; the defaults themselves are in Settings.
          </span>
        </span>
      </label>
    </ExpandableCard>
  );
}
