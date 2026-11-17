import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Loader, Network } from "lucide-react";
import type { StatusSummary } from "../../api/types";
import { TimeAgo } from "../../components/TimeAgo";
import { Badge } from "../../components/ui/badge";
import { api } from "../../api/client";
import { formatRate } from "../../lib/format";
import { queryKeys } from "../../lib/queryKeys";
import { PEER_STATE } from "../../lib/peerState";
import { usePeers } from "../../lib/usePeers";

const pct = (value: number | null | undefined): string => (value === null || value === undefined ? "n/a" : `${value.toFixed(0)}%`);

function Numbers({ summary }: { summary: StatusSummary | null }) {
  if (!summary) return <td colSpan={6} className="px-3 py-2.5 text-xs text-[var(--dim)]">No numbers yet.</td>;
  const host = summary.host;
  return (
    <>
      <td className="px-3 py-2.5">{pct(host?.cpuPercent)}</td>
      <td className="px-3 py-2.5">{pct(host?.memPercent)}</td>
      <td className="px-3 py-2.5">{pct(host?.diskUsedPct)}</td>
      <td className="px-3 py-2.5">{host && host.netRxBps !== null && host.netTxBps !== null ? `↓ ${formatRate(host.netRxBps)} ↑ ${formatRate(host.netTxBps)}` : "n/a"}</td>
      <td className="px-3 py-2.5">{summary.projects.ready}/{summary.projects.total}{summary.projects.down + summary.projects.problem > 0 ? ` (${summary.projects.down + summary.projects.problem} not ok)` : ""}{summary.runningActions > 0 ? `, ${summary.runningActions} running` : ""}</td>
      <td className="px-3 py-2.5">{summary.alerts.total === 0 ? "None" : <Badge variant={summary.alerts.critical > 0 ? "destructive" : "secondary"}>{summary.alerts.total}</Badge>}</td>
    </>
  );
}

/** Every instance side by side: this one and each peer, with what the peer last reported (kept in memory, so an offline peer shows its last numbers and how old they are). */
export default function FleetPage() {
  const { data, isLoading } = usePeers();
  // This instance's own numbers are collected on request, apart from the peers list the sidebar polls.
  const local = useQuery({ queryKey: queryKeys.localSummary, queryFn: () => api.getLocalSummary(), refetchInterval: 15_000, retry: false });
  return (
    <main className="main main-wide">
      <h1 className="page-title mb-4"><Network size={20} />Instances</h1>
      {isLoading || !data ? <div className="empty" style={{ padding: 48 }}><Loader size={22} className="spin" /></div> : (
        <div className="card overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-border text-xs text-[var(--dim)]">
                <th className="px-3 py-2 font-medium">Instance</th><th className="px-3 py-2 font-medium">State</th><th className="px-3 py-2 font-medium">CPU</th><th className="px-3 py-2 font-medium">Memory</th>
                <th className="px-3 py-2 font-medium">Disk</th><th className="px-3 py-2 font-medium">Network</th><th className="px-3 py-2 font-medium">Projects</th><th className="px-3 py-2 font-medium">Alerts</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-border">
                <td className="px-3 py-2.5 font-medium">{data.self.name} <span className="text-xs font-normal text-[var(--dim)]">(this instance)</span></td>
                <td className="px-3 py-2.5"><Badge>Local</Badge></td>
                <Numbers summary={local.data?.summary ?? null} />
              </tr>
              {data.controlling.map((peer) => {
                const state = PEER_STATE[peer.status.state] ?? PEER_STATE.unknown;
                return (
                  <tr key={peer.id} className="border-b border-border last:border-b-0">
                    <td className="px-3 py-2.5"><Link to={`/peers/${peer.id}`} className="font-medium underline-offset-2 hover:underline">{peer.name}</Link></td>
                    <td className="px-3 py-2.5">
                      <Badge variant={state.variant}>{state.label}</Badge>
                      {peer.summaryAt && peer.status.state !== "online" && <div className="mt-1 text-xs text-[var(--dim)]">last known <TimeAgo ts={peer.summaryAt} /></div>}
                    </td>
                    <Numbers summary={peer.summary} />
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-[var(--dim)]">Each peer keeps its own history and stays the source of truth. These numbers are what it last reported to this instance.</p>
    </main>
  );
}
