import { logger } from "../../shared/logger";
import { collectStatus, type CollectedState } from "./collect";
import { STATUS_SECTIONS, type Alert, type StatusSection, type StatusSnapshot } from "./types";

/**
 * The one place the live status is computed. It runs only while somebody is subscribed, looks at the app every `INTERVAL_MS`, and tells each
 * subscriber which sections changed. Transports (the WebSocket today) scope what they are given to what their token may see; the hub itself
 * knows nothing about tokens.
 */

const INTERVAL_MS = 10_000;
/** A snapshot older than this is collected again for a new subscriber instead of being sent as it is. */
const FRESH_MS = 12_000;

export type SectionUpdate = { [S in StatusSection]: { section: S; data: StatusSnapshot[S] } }[StatusSection];
type Listener = (update: SectionUpdate) => void;

export class StatusHub {
  private listeners = new Set<Listener>();
  private timer: NodeJS.Timeout | null = null;
  private latest: StatusSnapshot | null = null;
  private collectedAt = 0;
  private sent = new Map<StatusSection, string>();
  private firstSeen = new Map<string, string>();
  private inFlight: Promise<void> | null = null;

  constructor(private readonly collector: () => Promise<CollectedState> = collectStatus) {}

  /** Starts watching on the first subscriber and stops on the last, so an unused stream costs nothing. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    if (!this.timer) {
      this.timer = setInterval(() => { void this.refresh(); }, INTERVAL_MS);
      this.timer.unref();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  }

  /** What was last collected, without collecting; null when nothing is subscribed. Transports use it to scope an update. */
  peek(): StatusSnapshot | null {
    return this.latest;
  }

  /** The current state, collected now when what is held is stale. */
  async current(): Promise<StatusSnapshot> {
    if (!this.latest || Date.now() - this.collectedAt > FRESH_MS) await this.refresh();
    return this.latest ?? { host: null, projects: [], actions: [], alerts: [] };
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.latest = null;
    this.sent.clear();
    this.firstSeen.clear();
  }

  /** Collects once (several callers share it) and notifies the subscribers of what changed. */
  refresh(): Promise<void> {
    this.inFlight ??= this.collect().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async collect(): Promise<void> {
    try {
      const { snapshot, conditions } = await this.collector();
      const now = new Date().toISOString();
      const alerts: Alert[] = conditions.map((condition) => ({ ...condition, since: this.firstSeen.get(condition.id) ?? now }));
      // Forget the conditions that no longer hold, so one that comes back later has a new `since`.
      const live = new Set(alerts.map((alert) => alert.id));
      for (const id of [...this.firstSeen.keys()]) if (!live.has(id)) this.firstSeen.delete(id);
      for (const alert of alerts) this.firstSeen.set(alert.id, alert.since);

      this.latest = { ...snapshot, alerts };
      this.collectedAt = Date.now();
      for (const section of STATUS_SECTIONS) {
        // eslint-disable-next-line security/detect-object-injection -- the key is one of the fixed section names.
        const data = this.latest[section];
        const serialized = JSON.stringify(data);
        if (this.sent.get(section) === serialized) continue;
        this.sent.set(section, serialized);
        for (const listener of this.listeners) listener({ section, data } as SectionUpdate);
      }
    } catch (err) {
      // Keep the last good state; the next tick tries again.
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "status.collect-failed");
    }
  }
}

export const statusHub = new StatusHub();
