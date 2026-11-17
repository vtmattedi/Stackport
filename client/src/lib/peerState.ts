import type { PeerState } from "../api/types";

export const PEER_STATE: Record<PeerState, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  online: { label: "Online", variant: "default" },
  offline: { label: "Offline", variant: "secondary" },
  revoked: { label: "Access revoked", variant: "destructive" },
  "identity-mismatch": { label: "Identity changed", variant: "destructive" },
  "version-mismatch": { label: "Incompatible version", variant: "destructive" },
  unknown: { label: "Not checked yet", variant: "outline" },
};
