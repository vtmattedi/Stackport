import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Server } from "lucide-react";
import type { PeerTarget } from "../api/types";
import { PEER_STATE } from "../lib/peerState";
import { usePeers } from "../lib/usePeers";
import { Badge } from "./ui/badge";
import { TimeAgo } from "./TimeAgo";

/** Switches between this instance and the peers. A change navigates to that instance's page, so what is selected is always in the address. */
function InstanceSwitcher({ current }: { current: number }) {
  const navigate = useNavigate();
  const peers = usePeers().data?.controlling ?? [];
  if (peers.length < 2) return null;
  return (
    <select
      aria-label="Switch instance"
      className="rounded border border-border bg-transparent px-1.5 py-0.5 text-xs"
      value={String(current)}
      onChange={(event) => navigate(event.target.value === "local" ? "/projects" : `/peers/${event.target.value}`)}
    >
      <option value="local">This instance</option>
      {peers.map((peer) => <option key={peer.id} value={String(peer.id)}>{peer.name}</option>)}
    </select>
  );
}

/** Says which instance a page is about. Shown on every peer page, so what is on screen is never mistaken for this instance's own. */
export function PeerBanner({ peer, stale, fetchedAt }: { peer: PeerTarget; stale?: boolean; fetchedAt?: string }) {
  const state = PEER_STATE[peer.status.state] ?? PEER_STATE.unknown;
  return (
    <div role="status" className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-[var(--brand)] bg-[color-mix(in_srgb,var(--brand)_8%,transparent)] px-3 py-2 text-[13px]">
      <Server size={14} />
      <span>Another instance: <strong>{peer.name}</strong></span>
      <Badge variant={state.variant}>{state.label}</Badge>
      <span className="mono text-xs text-[var(--dim)]">{peer.endpoint}</span>
      {stale && <Badge variant="secondary">Last known, fetched <TimeAgo ts={fetchedAt} /></Badge>}
      <InstanceSwitcher current={peer.id} />
      <Link to="/projects" className="ml-auto inline-flex items-center gap-1 text-xs underline"><ArrowLeft size={12} />Back to this instance</Link>
    </div>
  );
}
