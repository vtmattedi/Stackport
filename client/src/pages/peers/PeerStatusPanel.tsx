import { useQuery } from "@tanstack/react-query";
import { Activity, Loader } from "lucide-react";
import { api, ApiError } from "../../api/client";
import type { PeerHostStatus, PeerTarget } from "../../api/types";
import { TimeAgo } from "../../components/TimeAgo";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { formatRate } from "../../lib/format";
import { queryKeys } from "../../lib/queryKeys";

function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="min-w-[8rem] flex-1">
      <div className="text-[11px] uppercase tracking-wide text-[var(--dim)]">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
      {detail && <div className="text-xs text-[var(--dim)]">{detail}</div>}
    </div>
  );
}

export function HostMetrics({ host }: { host: PeerHostStatus }) {
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-3">
      <Metric label="CPU" value={`${host.cpuPercent.toFixed(0)}%`} detail={`load ${host.load1}`} />
      <Metric label="Memory" value={`${host.memPercent.toFixed(0)}%`} detail={`${host.memUsedMb} of ${host.memTotalMb} MB`} />
      <Metric label="Disk" value={host.diskUsedPct === null ? "n/a" : `${host.diskUsedPct.toFixed(0)}%`} detail="Docker data" />
      <Metric label="Network" value={host.netRxBps === null ? "n/a" : `↓ ${formatRate(host.netRxBps)}`} detail={host.netTxBps === null ? undefined : `↑ ${formatRate(host.netTxBps)}`} />
    </div>
  );
}

/** A peer's machine, running actions and alerts, as the peer reports them now. Read only; shown only for what this instance was granted. */
export function PeerStatusPanel({ peer }: { peer: PeerTarget }) {
  const query = useQuery({ queryKey: queryKeys.peerStatus(peer.id), queryFn: () => api.getPeerStatus(peer.id), refetchInterval: 15_000, retry: false });
  const report = query.data?.data;

  if (query.isLoading) return <div className="card"><Loader size={14} className="spin" /></div>;
  // Neither read grant: there is nothing to show, and that is not an error on the peer. Anything else says what went wrong.
  if (query.error instanceof ApiError && query.error.status === 403) return null;
  if (query.error || !report) {
    return <Alert variant="destructive" className="mb-4"><AlertDescription>Couldn't read {peer.name}'s status: {query.error instanceof Error ? query.error.message : "no answer"}.</AlertDescription></Alert>;
  }

  return (
    <div className="card mb-4">
      <div className="card-title flex items-center gap-2"><Activity size={13} />Status<span className="ml-auto font-normal normal-case text-[var(--dim)]">read <TimeAgo ts={query.data?.fetchedAt} />{query.data?.stale ? ", last known" : ""}</span></div>
      <div className="grid gap-4">
        {report.host ? <HostMetrics host={report.host} /> : <div className="text-xs text-[var(--dim)]">This instance was not granted the host metrics.</div>}
        {report.actions.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-medium text-[var(--dim)]">Running now</div>
            <ul className="grid gap-1 text-[13px]">
              {report.actions.map((action) => (
                <li key={action.id} className="flex flex-wrap items-center gap-x-3">
                  <Badge variant="secondary">{action.kind}</Badge>
                  <span>{action.projectName ?? "host"}</span>
                  {action.phase && <span className="text-xs text-[var(--dim)]">{action.phase}</span>}
                  {action.percent !== null && <span className="text-xs text-[var(--dim)]">{action.percent}%</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
        {report.alerts.length > 0 && (
          <div className="grid gap-1.5">
            {report.alerts.map((alert) => (
              <Alert key={alert.id} variant={alert.severity === "critical" ? "destructive" : "default"}>
                <AlertDescription><strong>{alert.subject}</strong>: {alert.message} <span className="text-[var(--dim)]">since <TimeAgo ts={alert.since} /></span></AlertDescription>
              </Alert>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
