import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, CircleDashed, Loader, X } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { MoveRun, MoveRunState } from "../api/types";
import { formatBytes } from "../lib/format";
import { notify } from "../lib/notify";
import { queryKeys } from "../lib/queryKeys";
import { useConfirm } from "./ConfirmDialog";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";

const ENDED: MoveRunState[] = ["done", "aborted", "failed", "interrupted", "needs-attention"];
export const isEnded = (state: MoveRunState): boolean => ENDED.includes(state);

/** One move, live: each step, what the two sides report, and, once the copy is verified and running, the only question that matters. */
export function MoveProgress({ moveId, sourceName, targetName, targetPeerId }: { moveId: string; sourceName: string; targetName: string; targetPeerId: number | null }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  // Once the user has chosen, the choice is made: the buttons stay off until the move reports what happened.
  const [decided, setDecided] = useState(false);
  const { data: run, error } = useQuery({
    queryKey: queryKeys.move(moveId),
    queryFn: () => api.getMove(moveId),
    refetchInterval: (query) => (query.state.data && isEnded(query.state.data.state) ? false : 2000),
  });

  const ended = run ? isEnded(run.state) : false;
  // A finished move changed what exists on both instances: the lists and pages that show projects must look again.
  useEffect(() => {
    if (!ended) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    void queryClient.invalidateQueries({ queryKey: ["project"] });
    void queryClient.invalidateQueries({ queryKey: ["peers"] });
    void queryClient.invalidateQueries({ queryKey: queryKeys.peers });
  }, [ended, queryClient]);

  if (!run) return error ? <Alert variant="destructive"><AlertDescription>{error instanceof Error ? error.message : "Couldn't read the move."}</AlertDescription></Alert> : <Loader size={16} className="spin" />;

  async function decide(kind: "confirm" | "abort") {
    if (kind === "confirm") {
      const ok = await confirm({
        title: `Remove ${run?.projectName} from ${sourceName}?`,
        description: `The copy on ${targetName} is verified and running. Confirming deletes the original on ${sourceName}, its containers, volumes and files. There is no undo and no retention: keep an archive (stackport backup --project) first if you want a safety net.`,
        confirmLabel: "Confirm and remove the original",
        destructive: true,
        requireText: run?.projectName,
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const next = kind === "confirm" ? await api.confirmMove(moveId) : await api.abortMove(moveId);
      setDecided(true);
      queryClient.setQueryData(queryKeys.move(moveId), next);
      void queryClient.invalidateQueries({ queryKey: queryKeys.moves });
    } catch (err) { notify.error(err, kind === "confirm" ? "Couldn't confirm the move" : "Couldn't abort the move"); } finally { setBusy(false); }
  }

  const waiting = run.state === "awaiting-confirmation";
  return (
    <div className="grid gap-3">
      <ol className="grid gap-2">
        {run.steps.map((step, index) => (
          <li key={`${step.name}:${index}`} className="flex gap-2 text-[13px]">
            <span className="mt-0.5 shrink-0">
              {step.status === "ok" ? <Check size={14} className="text-[var(--ok,#22c55e)]" /> : step.status === "failed" ? <X size={14} className="text-destructive" /> : ended ? <CircleDashed size={14} className="text-[var(--dim)]" /> : <Loader size={14} className="spin" />}
            </span>
            <span className="min-w-0">
              <span className="font-medium">{step.name}</span>
              {step.detail && <span className="block text-xs text-[var(--dim)]">{step.detail}</span>}
            </span>
          </li>
        ))}
        {!isEnded(run.state) && run.steps.length === 0 && <li className="flex gap-2 text-[13px]"><CircleDashed size={14} className="mt-0.5" />Starting…</li>}
      </ol>

      {run.sourceMove && run.sourceMove.state === "transferring" && run.sourceMove.sentBytes > 0 && <div className="text-xs text-[var(--dim)]">Sent {formatBytes(run.sourceMove.sentBytes)} so far.</div>}

      {run.transfer && (run.transfer.notCarried.length > 0 || run.transfer.warnings.length > 0 || run.transfer.hostnames.length > 0) && (
        <div className="rounded-md border border-border p-3 text-xs">
          {run.transfer.hostnames.length > 0 && <div className="mb-2">Hostname on {targetName}: <span className="mono">{run.transfer.hostnames.join(", ")}</span>. It starts without TLS: point its DNS here, then turn TLS on from the project's Hostnames tab.</div>}
          {run.transfer.warnings.map((warning) => <div key={warning} className="mb-1 text-[var(--warn,#d97706)]">{warning}</div>)}
          {run.transfer.notCarried.length > 0 && (
            <details>
              <summary className="cursor-pointer text-[var(--dim)]">Not carried over ({run.transfer.notCarried.length})</summary>
              <ul className="mt-1 list-disc pl-5 text-[var(--dim)]">{run.transfer.notCarried.map((line) => <li key={line}>{line}</li>)}</ul>
            </details>
          )}
        </div>
      )}

      {waiting && (
        <Alert>
          <AlertDescription>
            <strong>{run.projectName}</strong> is stopped on {sourceName} and running on {targetName}, and its data was verified byte for byte. Check the copy now. Nothing on {sourceName} is removed until you confirm, and aborting puts it back exactly as it was.
            <div className="mt-3 flex flex-wrap gap-2">
              <Button type="button" size="sm" disabled={busy || decided} onClick={() => void decide("confirm")}>{busy && <Loader size={13} className="spin" />}Confirm and remove the original</Button>
              <Button type="button" size="sm" variant="outline" disabled={busy || decided} onClick={() => void decide("abort")}>Abort and go back</Button>
            </div>
          </AlertDescription>
        </Alert>
      )}
      {!waiting && !isEnded(run.state) && run.state !== "committing" && run.state !== "aborting" && (
        <div><Button type="button" size="sm" variant="outline" disabled={busy || decided} onClick={() => void decide("abort")}>Abort</Button></div>
      )}

      {run.state === "done" && (
        <Alert><AlertDescription>
          Moved. <strong>{run.projectName}</strong> now runs on {targetName}{targetPeerId !== null && <> — <Link to={`/peers/${targetPeerId}`} className="underline">open it there</Link></>}.
        </AlertDescription></Alert>
      )}
      {(run.state === "aborted") && <Alert><AlertDescription>The move was aborted. {run.projectName} is back on {sourceName} as it was, and the copy on {targetName} was removed.</AlertDescription></Alert>}
      {run.state === "failed" && <Alert variant="destructive"><AlertDescription>The move failed and was undone: {run.error}. {run.projectName} is back on {sourceName}.</AlertDescription></Alert>}
      {(run.state === "needs-attention" || run.state === "interrupted") && (
        <Alert variant="destructive">
          <AlertDescription>
            <div className="mb-1 flex items-center gap-1.5 font-medium"><AlertTriangle size={14} />Needs your attention</div>
            {run.error}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

export type { MoveRun };
