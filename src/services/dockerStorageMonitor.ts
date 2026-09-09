import { pollingCadenceS } from "../config/pollingCadence";
import { auditLog } from "../utils/logger";
import { pruneBuildCache } from "./dockerStatusCache";
import { getStorageState } from "./dockerStorage";

/** Phase 1.4 — proactive background counterpart to ensureBuildCapacity()'s
 *  synchronous pre-build guard: on a `warning`-level threshold crossing (before
 *  things reach `critical` and start blocking builds), automatically runs the same
 *  build-cache-only prune the manual button uses. Never touches project volumes. */
class DockerStorageMonitor {
  private timer: NodeJS.Timeout | null = null;
  private checking = false;

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.check(), pollingCadenceS.dockerStorageCheck * 1000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const before = await getStorageState();
      if (before.state !== "warning" && before.state !== "critical") return;

      const result = await pruneBuildCache();
      const after = await getStorageState();
      auditLog("system", "system.docker-storage-auto-prune", "docker", result.ok ? "ok" : "fail", {
        triggerState: before.state,
        freeBytesBefore: before.freeBytes,
        freeBytesAfter: after.freeBytes,
      });
    } catch {
      // best-effort background maintenance — a failed check just tries again next tick
    } finally {
      this.checking = false;
    }
  }
}

export const dockerStorageMonitor = new DockerStorageMonitor();
