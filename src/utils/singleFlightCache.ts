/**
 * A TTL'd cache around a single async value, with in-flight de-duplication: if a
 * fetch is already running when a second caller asks for the value, that caller
 * shares the same in-flight promise instead of starting a redundant fetch — the
 * "single-flight" part. This is what lets many independent pollers (a socket-pushed
 * status channel, a REST fallback, a resource sampler on its own timer, several
 * connected browser tabs) share one underlying subprocess call instead of each
 * spawning their own.
 *
 * `ttlMs: null` means "cache indefinitely once fetched" — used for values that only
 * change at startup or in response to an explicit action (e.g. a version check after
 * installing a tool), never on a timer.
 */
export class SingleFlightCache<T> {
  private value: T | undefined;
  private hasValue = false;
  private fetchedAt = 0;
  private inFlight: Promise<T> | null = null;

  constructor(
    private readonly fetcher: () => Promise<T>,
    private readonly ttlMs: number | null,
  ) {}

  async get(): Promise<T> {
    if (this.hasValue && this.isFresh()) return this.value as T;
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.fetcher()
      .then((value) => {
        this.value = value;
        this.hasValue = true;
        this.fetchedAt = Date.now();
        return value;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /** Drops the cached value so the next `get()` performs a fresh fetch (coalesced
   *  with any concurrent callers via the same in-flight mechanism). Used by
   *  event-driven invalidation — e.g. right after a deploy finishes or a cert issues. */
  invalidate(): void {
    this.hasValue = false;
  }

  private isFresh(): boolean {
    return this.ttlMs == null || Date.now() - this.fetchedAt < this.ttlMs;
  }
}
