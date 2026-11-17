import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { queryKeys } from "./queryKeys";

/** The paired peers and their connection state. One shared query: the sidebar, the Peers settings and the peer pages all read it. */
export function usePeers() {
  return useQuery({ queryKey: queryKeys.peers, queryFn: () => api.getPeers(), refetchInterval: 30_000, staleTime: 10_000 });
}
