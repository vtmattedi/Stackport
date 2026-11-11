import { useState } from "react";
import { ShieldAlert } from "lucide-react";
import { ExpandableCard } from "../../components/ExpandableCard";
import { Switch } from "../../components/ui/switch";
import { api } from "../../api/client";
import type { Project } from "../../api/types";
import { notify } from "../../lib/notify";
import styles from "../ProjectDetails.module.scss";

/** Per-project switch for rejecting Compose policy violations. Projects that existed before
 *  1.3 start with it off, so a violation only warns. Saves on change; it applies on the next deploy. */
export function PolicyCard({ project, setProject }: { project: Project; setProject: (next: Project) => void }) {
  const [saving, setSaving] = useState(false);

  async function toggle(enforced: boolean) {
    setSaving(true);
    try {
      const result = await api.setProjectComposePolicyEnforcement(project.id, enforced);
      setProject({ ...project, composePolicyEnforced: result.composePolicyEnforced });
      notify.success(enforced ? "Compose policy enforced. It applies on the next deploy." : "Compose policy now only warns. This applies on the next deploy.");
    } catch (err) {
      notify.error(err, "Could not change the Compose policy");
    } finally {
      setSaving(false);
    }
  }

  return (
    <ExpandableCard
      icon={<ShieldAlert size={13} />}
      title="Compose Policy"
      storageKey="project.compose-policy"
      summary={<span>{project.composePolicyEnforced ? "Enforced" : "Warn only"}</span>}
    >
      <label className={styles.switchField}>
        <Switch checked={project.composePolicyEnforced} disabled={saving} onCheckedChange={(value) => void toggle(value)} />
        <span>
          <span>Reject policy violations</span>
          <span>
            A deploy fails when the Compose file, after Compose has resolved it, breaks the policy, or when it cannot be
            resolved to check. With this off the deploy goes ahead and the problem is only reported as a warning in the
            deploy log. Checks on the raw file apply either way. Turn it on once the project's Compose file passes.
          </span>
        </span>
      </label>
    </ExpandableCard>
  );
}
