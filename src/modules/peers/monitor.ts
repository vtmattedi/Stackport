import { logger } from "../../shared/logger";
import { listTargets } from "./store";
import { refreshTarget, type TargetStatus } from "./service";

/** Keeps each controlled peer's connection state and display name current. State is in memory: it describes the last attempt, and a restart starts at "unknown" until the first check. */
const INTERVAL_MS = 60_000;
const statuses = new Map<number, TargetStatus & { checkedAt: string }>();

export function peerStatus(id: number): (TargetStatus & { checkedAt: string }) | null {
  return statuses.get(id) ?? null;
}

export async function checkPeer(id: number): Promise<TargetStatus & { checkedAt: string }> {
  const status = await refreshTarget(id);
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
      for (const target of targets) {
        await checkPeer(target.id).catch((err: unknown) => logger.warn({ err, peer: target.instanceId }, "peers.check-failed"));
      }
    } finally {
      this.running = false;
    }
  }
}

export const peerMonitor = new PeerMonitor();
