import { useState } from "react";
import { MoveRight } from "lucide-react";
import { MoveProjectDialog } from "../../components/MoveProjectDialog";
import { Button } from "../../components/ui/button";
import type { Project } from "../../api/types";
import { usePeers } from "../../lib/usePeers";

/** Move this project to another instance this one controls. Shown only when there is one. */
export function MoveCard({ project, currentHostname }: { project: Project; currentHostname: string | null }) {
  const { data: overview } = usePeers();
  const [open, setOpen] = useState(false);
  if (!overview || overview.controlling.length === 0) return null;
  return (
    <div className="card mt-4">
      <div className="card-title flex items-center gap-2"><MoveRight size={13} />Move to another instance</div>
      <p className="mb-3 text-xs text-[var(--dim)]">Stop this project, copy it with all of its data and secrets to another instance, verify the copy and start it there. The original is removed only after you confirm.</p>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>Move…</Button>
      {open && <MoveProjectDialog source={{ kind: "local" }} projectId={project.id} projectName={project.name} currentHostname={currentHostname} onClose={() => setOpen(false)} />}
    </div>
  );
}
