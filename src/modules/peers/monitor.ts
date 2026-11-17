import { logger } from "../../shared/logger";
import { hasGrant } from "./grants";
import { getTarget, listTargets } from "./store";
import { isStatusReport } from "./peerStatus";
import { forgetRemoteCache, refreshTarget, remoteGet, STATUS_PATH, type TargetStatus } from "./service";

/** Keeps each controlled peer's connection state and display name current. State is in memory: it describes the last attempt, and a restart starts at "unknown" until the first check. */
const INTERVAL_MS = 60_000;
const statuses = new Map<number, TargetStatus & { checkedAt: string }>();

export function peerStatus(id: number): (TargetStatus & { checkedAt: string }) | null {
  return statuses.get(id) ?? null;
}

export async function checkPeer(id: number): Promise<TargetStatus & { checkedAt: string }> {
  const status = await refreshTarget(id);
  // A peer that revoked this instance, was replaced or no longer speaks the protocol must not be shown from what it said before.
  if (status.state === "revoked" || status.state === "identity-mismatch" || status.state === "version-mismatch") forgetRemoteCache(id);
  const entry = { ...status, checkedAt: new Date().toISOString() };
  statuses.set(id, entry);
  return entry;
}

export function forgetPeer(id: number): void {
  statuses.delete(id);
}

class PeerMonitor {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // One peer at a time: a slow or unreachable peer must not delay the others' checks beyond its own timeout.
      const targets = listTargets();
      // Drop the state of peers that no longer exist (removed by a restore, say), so an id is never shown another peer's status.
      const live = new Set(targets.map((t) => t.id));
      for (const id of [...statuses.keys()]) if (!live.has(id)) statuses.delete(id);
      const online: typeof targets = [];
      for (const target of targets) {
        const status = await checkPeer(target.id).catch((err: unknown) => { logger.warn({ err, peer: target.instanceId }, "peers.check-failed"); return null; });
        if (status?.state !== "online") continue;
        // Grants as the peer just reported them (checkPeer stored them). With neither read grant there is nothing to read, and nothing from before may stay shown.
        const granted = getTarget(target.id)?.grants ?? [];
        if (!hasGrant(granted, "host:read") && !hasGrant(granted, "projects:read")) { forgetRemoteCache(target.id); continue; }
        online.push(target);
      }
      // After every check, so a slow peer's status cannot delay the others' state; the reads themselves run together.
      await Promise.allSettled(online.map((target) => remoteGet(target.id, STATUS_PATH, { validate: isStatusReport }).catch((err: unknown) => logger.warn({ err: err instanceof Error ? err.message : String(err), peer: target.instanceId }, "peers.status-failed"))));
    } finally {
      this.running = false;
    }
  }
}

export const peerMonitor = new PeerMonitor();
