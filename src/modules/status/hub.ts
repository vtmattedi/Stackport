import { logger } from "../../shared/logger";
import { collectStatus, type CollectedState } from "./collect";
import { STATUS_SECTIONS, type Alert, type StatusSection, type StatusSnapshot } from "./types";

/**
 * The one place the live status is computed. It runs only while somebody is subscribed, looks at the app every `INTERVAL_MS`, and tells each
 * subscriber which sections changed. Transports (the WebSocket today) scope what they are given to what their token may see; the hub itself
 * knows nothing about tokens.
 *
 * It never invents data. If nothing has been collected yet, `current()` fails rather than returning an empty snapshot that a reader would
 * take as "no projects, no alerts"; and `ageSeconds()` says how old the data is, so a collector that keeps failing shows up as old data
 * instead of as a quiet, healthy-looking stream.
 */

const INTERVAL_MS = 10_000;
/** A snapshot older than this is collected again for a new subscriber instead of being sent as it is. */
const FRESH_MS = 12_000;
/** A collection that has not finished by now is given up on, so one stalled Docker call cannot freeze every later one. */
const COLLECT_TIMEOUT_MS = 20_000;

export type SectionUpdate = { [S in StatusSection]: { section: S; data: StatusSnapshot[S] } }[StatusSection];
type Listener = (update: SectionUpdate) => void;

export class StatusHub {
  private listeners = new Set<Listener>();
  private timer: NodeJS.Timeout | null = null;
  private latest: StatusSnapshot | null = null;
  private groups = new Map<number, string | null>();
  private collectedAt = 0;
  private sent = new Map<StatusSection, string>();
  private firstSeen = new Map<string, string>();
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly collector: () => Promise<CollectedState> = collectStatus,
    private readonly timeoutMs: number = COLLECT_TIMEOUT_MS,
  ) {}

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

  /** What was last collected, without collecting; null when nothing is subscribed or nothing has been collected. Transports use it to scope an update. */
  peek(): StatusSnapshot | null {
    return this.latest;
  }

  /** Each project's group exactly as stored (the snapshot's own `group` is cut for the wire), for deciding what a group-limited token may see. */
  rawGroups(): ReadonlyMap<number, string | null> {
    return this.groups;
  }

  /** How old the data is, in seconds; null when there is none. A stream whose collector keeps failing says so here. */
  ageSeconds(): number | null {
    return this.latest ? Math.round((Date.now() - this.collectedAt) / 1000) : null;
  }

  /** The current state, collected now when what is held is stale. Fails when there is nothing to report: an empty answer would read as "all clear". */
  async current(): Promise<StatusSnapshot> {
    if (!this.latest || Date.now() - this.collectedAt > FRESH_MS) await this.refresh();
    if (!this.latest) throw new Error("status could not be collected");
    return this.latest;
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.latest = null;
    this.groups = new Map();
    this.sent.clear();
    this.firstSeen.clear();
  }

  /** Collects once (several callers share it) and notifies the subscribers of what changed. */
  refresh(): Promise<void> {
    this.inFlight ??= this.collect().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async withTimeout(): Promise<CollectedState> {
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("collection timed out")), this.timeoutMs); });
    try {
      return await Promise.race([this.collector(), limit]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async collect(): Promise<void> {
    try {
      const { snapshot, conditions, groups } = await this.withTimeout();
      const now = new Date().toISOString();
      const alerts: Alert[] = conditions.map((condition) => ({ ...condition, since: this.firstSeen.get(condition.id) ?? now }));
      // Forget the conditions that no longer hold, so one that comes back later has a new `since`.
      const live = new Set(alerts.map((alert) => alert.id));
      for (const id of [...this.firstSeen.keys()]) if (!live.has(id)) this.firstSeen.delete(id);
      for (const alert of alerts) this.firstSeen.set(alert.id, alert.since);

      this.latest = { ...snapshot, alerts };
      this.groups = groups;
      this.collectedAt = Date.now();
      for (const section of STATUS_SECTIONS) {
        // eslint-disable-next-line security/detect-object-injection -- the key is one of the fixed section names.
        const data = this.latest[section];
        const serialized = JSON.stringify(data);
        if (this.sent.get(section) === serialized) continue;
        this.sent.set(section, serialized);
        // One listener failing must not stop the others, or the sections after this one, from hearing about the change.
        for (const listener of this.listeners) {
          try { listener({ section, data } as SectionUpdate); }
          catch (err) { logger.warn({ err: err instanceof Error ? err.message : String(err) }, "status.listener-failed"); }
        }
      }
    } catch (err) {
      // Keep the last good state (its age grows); the next tick tries again.
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "status.collect-failed");
    }
  }
}

export const statusHub = new StatusHub();
