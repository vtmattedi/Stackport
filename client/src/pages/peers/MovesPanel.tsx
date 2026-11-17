import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MoveRight, X } from "lucide-react";
import { api } from "../../api/client";
import type { MoveEndpoint, MoveRun, MoveRunState } from "../../api/types";
import { MoveProgress, isEnded } from "../../components/MoveProgress";
import { TimeAgo } from "../../components/TimeAgo";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { queryKeys } from "../../lib/queryKeys";
import { usePeers } from "../../lib/usePeers";

const LABEL: Record<MoveRunState, { text: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  preparing: { text: "Preparing", variant: "secondary" },
  transferring: { text: "Copying", variant: "secondary" },
  importing: { text: "Verifying", variant: "secondary" },
  starting: { text: "Starting", variant: "secondary" },
  "awaiting-confirmation": { text: "Waiting for you", variant: "default" },
  committing: { text: "Removing the original", variant: "secondary" },
  done: { text: "Done", variant: "outline" },
  aborting: { text: "Undoing", variant: "secondary" },
  aborted: { text: "Aborted", variant: "outline" },
  failed: { text: "Failed, undone", variant: "outline" },
  interrupted: { text: "Interrupted", variant: "destructive" },
  "needs-attention": { text: "Needs attention", variant: "destructive" },
};

/** Moves this instance has directed, newest first. One that is waiting for the user, or that needs attention, is the first thing to look at. */
export function MovesPanel() {
  const { data: overview } = usePeers();
  const [open, setOpen] = useState<MoveRun | null>(null);
  const { data } = useQuery({
    queryKey: queryKeys.moves,
    queryFn: () => api.getMoves(),
    refetchInterval: (query) => (query.state.data?.moves.some((move) => !isEnded(move.state)) ? 3000 : 30_000),
  });
  const moves = data?.moves ?? [];
  if (moves.length === 0) return null;
  const nameOf = (ref: MoveEndpoint): string => (ref.kind === "local" ? overview?.self.name ?? "This instance" : overview?.controlling.find((p) => p.id === ref.peerId)?.name ?? `Peer ${ref.peerId}`);

  return (
    <section className="mt-6">
      <h2 className="mb-2 flex items-center gap-2 text-sm font-medium"><MoveRight size={14} />Moves</h2>
      <div className="card overflow-x-auto">
        <table className="w-full text-left text-[13px]">
          <tbody>
            {moves.map((move) => (
              <tr key={move.id} className="border-b border-border last:border-b-0">
                <td className="px-3 py-2.5 font-medium">{move.projectName}</td>
                <td className="px-3 py-2.5">{nameOf(move.source)} → {nameOf(move.target)}</td>
                <td className="px-3 py-2.5"><Badge variant={LABEL[move.state].variant}>{LABEL[move.state].text}</Badge></td>
                <td className="px-3 py-2.5 text-xs text-[var(--dim)]"><TimeAgo ts={move.updatedAt} /></td>
                <td className="px-3 py-2.5 text-right"><Button type="button" variant="ghost" size="sm" onClick={() => setOpen(move)}>{isEnded(move.state) ? "Details" : "Open"}</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open && (
        <div className="confirm-backdrop" role="presentation" onMouseDown={() => setOpen(null)}>
          <div className="confirm-panel confirm-panel-wide confirm-panel-form" role="dialog" aria-modal="true" aria-label={`Move of ${open.projectName}`} onMouseDown={(event) => event.stopPropagation()}>
            <div className="confirm-copy">
              <div className="mb-3 flex items-start gap-2">
                <h2 className="flex-1">{open.projectName}: {nameOf(open.source)} → {nameOf(open.target)}</h2>
                <Button type="button" variant="ghost" size="sm" aria-label="Close" onClick={() => setOpen(null)}><X size={14} /></Button>
              </div>
              <MoveProgress moveId={open.id} sourceName={nameOf(open.source)} targetName={nameOf(open.target)} targetPeerId={open.target.kind === "peer" ? open.target.peerId : null} />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
