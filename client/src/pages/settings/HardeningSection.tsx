import { useEffect, useState } from "react";
import { AlertCircle, Loader, Save } from "lucide-react";
import { api, ApiError } from "../../api/client";
import type { HardeningDefaults } from "../../api/types";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { NumberInput } from "../../components/NumberInput";
import { notify } from "../../lib/notify";

/** The memory and process limits every service gets when its Compose file sets none. */
export default function HardeningSection() {
  const [saved, setSaved] = useState<HardeningDefaults | null>(null);
  const [draft, setDraft] = useState<HardeningDefaults | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.getHardeningDefaults()
      .then((values) => { setSaved(values); setDraft(values); })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load the defaults"));
  }, []);

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      const next = await api.updateHardeningDefaults(draft);
      setSaved(next);
      setDraft(next);
      notify.success("Saved. Projects pick the new limits up on their next deploy.");
    } catch (err) {
      notify.error(err, "Could not save the defaults");
    } finally {
      setSaving(false);
    }
  }

  if (error) return <Alert variant="destructive"><AlertCircle size={14} /><AlertDescription>{error}</AlertDescription></Alert>;
  if (!draft || !saved) return <Loader size={14} className="spin" />;

  const dirty = draft.pidsLimit !== saved.pidsLimit || draft.memoryMb !== saved.memoryMb;
  return (
    <div className="card">
      <p className="hint">
        Projects with hardened defaults on give every service <code>no-new-privileges</code>, and these limits when the service's
        own Compose file sets none. A service that declares a limit keeps it. Set a value to 0 to have no default for it.
      </p>
      <div className="field">
        <label>Memory per service</label>
        <NumberInput min={0} max={16_777_216} suffix="MB" aria-label="Default memory limit in megabytes" value={draft.memoryMb}
          onValueChange={(value) => setDraft({ ...draft, memoryMb: value ?? 0 })} />
      </div>
      <div className="field">
        <label>Processes per service</label>
        <NumberInput min={0} max={4_194_304} aria-label="Default process limit" value={draft.pidsLimit}
          onValueChange={(value) => setDraft({ ...draft, pidsLimit: value ?? 0 })} />
      </div>
      <Button type="button" size="sm" disabled={!dirty || saving} onClick={() => void save()}>
        {saving ? <Loader size={14} className="spin" /> : <Save size={14} />} Save
      </Button>
    </div>
  );
}
