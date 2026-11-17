import { Link, Outlet, useOutletContext, useParams } from "react-router-dom";
import { Loader } from "lucide-react";
import type { PeerTarget } from "../../api/types";
import { usePeers } from "../../lib/usePeers";

/** `/peers/:peerId/...`: resolves the peer once and hands it to the nested pages. */
export function usePeer(): PeerTarget {
  return useOutletContext<PeerTarget>();
}

export default function PeerLayout() {
  const { peerId } = useParams();
  const { data, isLoading, error } = usePeers();
  const peer = data?.controlling.find((target) => String(target.id) === peerId);
  if (isLoading) return <main className="main"><div className="empty" style={{ padding: 48 }}><Loader size={22} className="spin" /></div></main>;
  if (error && !data) {
    return (
      <main className="main">
        <div className="empty">Couldn't load the registered instances: {error instanceof Error ? error.message : "unknown error"}.</div>
      </main>
    );
  }
  if (!peer) {
    return (
      <main className="main">
        <div className="empty">This instance is not registered here. <Link to="/settings/peers" className="underline">Open Peers settings</Link>.</div>
      </main>
    );
  }
  return <Outlet context={peer} />;
}
