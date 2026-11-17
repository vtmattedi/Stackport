import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader, Pause, Play, RefreshCw, Rocket, RotateCcw, Square, DownloadCloud, Hammer } from "lucide-react";
import { api } from "../../api/client";
import type { ActionRecord, PeerTarget, RemoteProjectDetail } from "../../api/types";
import { useConfirm } from "../../components/ConfirmDialog";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { notify } from "../../lib/notify";
import { usePeerCall } from "../../lib/usePeerCall";
import { queryKeys } from "../../lib/queryKeys";

interface Started { ok: boolean; started: boolean; action: ActionRecord | null; error?: string }

/** The action this instance started on the peer, followed by id until it ends. The peer runs it and reports its progress; nothing here runs on this instance. */
function ActionProgress({ peer, actionId, onDone }: { peer: PeerTarget; actionId: string; onDone: () => void }) {
  const [log, setLog] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["peers", peer.id, "action", actionId],
    queryFn: () => api.peerRequest<ActionRecord>(peer.id, "GET", `/actions/${actionId}`),
    refetchInterval: (q) => (q.state.data?.status === "running" || !q.state.data ? 2000 : false),
    retry: false,
  });
  const action = query.data;
  const finished = !!action && action.status !== "running";

  // Told once, when it ends, so the project page can refresh what changed.
  const report = useRef(onDone);
  report.current = onDone;
  useEffect(() => { if (finished) report.current(); }, [finished]);

  if (query.error) return <Alert variant="destructive" className="mb-4"><AlertDescription>Lost track of the action: {query.error instanceof Error ? query.error.message : "unknown error"}. It keeps running on {peer.name}.</AlertDescription></Alert>;
  if (!action) return <div className="mb-4 flex items-center gap-2 text-xs text-[var(--dim)]"><Loader size={13} className="spin" />Waiting for {peer.name}…</div>;

  return (
    <div className="mb-4 rounded-md border border-border p-3 text-[13px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Badge variant={action.status === "running" ? "secondary" : action.ok ? "default" : "destructive"}>{action.status === "running" ? "Running" : action.ok ? "Succeeded" : "Failed"}</Badge>
        <span className="font-medium">{action.kind}</span>
        {action.phase && <span className="text-xs text-[var(--dim)]">{action.phase}</span>}
        {action.status === "running" && action.progress !== null && <span className="text-xs text-[var(--dim)]">{Math.round(action.progress)}%</span>}
        <span className="text-xs text-[var(--dim)]">on {peer.name}</span>
        {finished && (
          <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={() => void api.peerActionLog(peer.id, actionId).then(setLog).catch((err: unknown) => notify.error(err, "Couldn't read the output"))}>View output</Button>
        )}
      </div>
      {action.status === "running" && action.progress !== null && (
        <div className="mt-2 h-1.5 overflow-hidden rounded bg-border"><div className="h-full bg-[var(--brand)]" style={{ width: `${Math.min(100, Math.max(0, action.progress))}%` }} /></div>
      )}
      {log !== null && <pre className="output-block mt-2 max-h-80 overflow-auto text-xs">{log || "No output."}</pre>}
    </div>
  );
}

/** Deploy, rebuild, restart, stop and roll back a project on a peer, with its progress. Needs `projects:write` on the peer. */
export function PeerActions({ peer, project }: { peer: PeerTarget; project: RemoteProjectDetail }) {
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const call = usePeerCall(peer.id);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionId, setActionId] = useState<string | null>(null);
  const canWrite = peer.grants.includes("projects:write");

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.peerProject(peer.id, project.id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.peerProjects(peer.id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.peerDeploys(peer.id, project.id) });
  };

  async function run(label: string, path: string, options: { body?: unknown; confirmWith?: { title: string; description: string; destructive?: boolean } } = {}) {
    if (options.confirmWith && !(await confirm({ ...options.confirmWith, confirmLabel: label }))) return;
    setBusy(label);
    try {
      const result = await call<Started | unknown>("POST", `/projects/${project.id}${path}`, options.body);
      const started = result as Partial<Started>;
      if (started?.started && started.action) setActionId(started.action.id);
      else notify.success(`${label}: done on ${peer.name}.`);
      refresh();
    } catch (err) {
      notify.error(err, `${label} failed on ${peer.name}`);
    } finally {
      setBusy(null);
    }
  }

  if (!canWrite) return <div className="mb-4 text-xs text-[var(--dim)]">This instance can only look at {peer.name}'s projects: the peer did not grant changes.</div>;

  const button = (label: string, icon: React.ReactNode, onClick: () => void, variant: "default" | "outline" = "outline") => (
    <Button key={label} type="button" size="sm" variant={variant} disabled={busy !== null} onClick={onClick}>{busy === label ? <Loader size={13} className="spin" /> : icon}{label}</Button>
  );

  return (
    <>
      <div className="mb-4 flex flex-wrap gap-1.5">
        {button("Deploy", <Rocket size={13} />, () => void run("Deploy", "/deploy"), "default")}
        {button("Pull", <DownloadCloud size={13} />, () => void run("Pull", "/pull"))}
        {button("Rebuild", <Hammer size={13} />, () => void run("Rebuild", "/force-rebuild", { confirmWith: { title: `Rebuild ${project.name} on ${peer.name}?`, description: "Builds the images again without the cache and recreates the containers. The project is briefly unavailable." } }))}
        {button("Restart", <RefreshCw size={13} />, () => void run("Restart", "/recreate", { confirmWith: { title: `Restart ${project.name} on ${peer.name}?`, description: "Recreates the containers. The project is briefly unavailable." } }))}
        {button("Roll back", <RotateCcw size={13} />, () => void run("Roll back", "/rollback", { confirmWith: { title: `Roll ${project.name} back on ${peer.name}?`, description: "Restores the previous revision that was not rolled back from.", destructive: true } }))}
        {button("Stop", <Square size={13} />, () => void run("Stop", "/stop", { confirmWith: { title: `Stop ${project.name} on ${peer.name}?`, description: "Stops its containers. Its data is kept.", destructive: true } }))}
        {project.paused
          ? button("Resume", <Play size={13} />, () => void run("Resume", "/resume"))
          : button("Pause", <Pause size={13} />, () => void run("Pause", "/pause", { confirmWith: { title: `Pause ${project.name} on ${peer.name}?`, description: "Turns off its health checks and automatic deploys until it is resumed." } }))}
      </div>
      {actionId && <ActionProgress key={actionId} peer={peer} actionId={actionId} onDone={refresh} />}
    </>
  );
}
