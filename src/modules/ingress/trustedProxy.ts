import { lookup } from "dns/promises";

/**
 * Which peers may set `X-Forwarded-For` (S4).
 *
 * The app sits behind its own nginx, which appends the real client address. Express only
 * believes that header from a trusted peer. Trusting the whole private range, as before,
 * meant any container able to reach the app could claim any client address and slip past
 * the login rate limit. Now only loopback and the nginx container's own address are
 * trusted. nginx is found by name on the stack's network and looked up again regularly,
 * because its address changes when it restarts.
 */

export interface TrustedProxy {
  /** Express `trust proxy` function. */
  trust: (address: string) => boolean;
  refresh: () => Promise<void>;
  /** Starts the regular lookups and resolves once the first one has finished (or `maxWaitMs` has passed),
   *  so the server can wait for nginx's address before it takes requests. */
  start: (maxWaitMs?: number) => Promise<void>;
  stop: () => void;
}

type Lookup = (host: string) => Promise<string[]>;

const defaultLookup: Lookup = async (host) => (await lookup(host, { all: true })).map((entry) => entry.address);

/** Strips the IPv4-in-IPv6 prefix Node adds to addresses on a dual-stack socket. */
export function normalizeAddress(address: string): string {
  return address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
}

export function isLoopback(address: string): boolean {
  const normalized = normalizeAddress(address);
  return normalized === "::1" || normalized.startsWith("127.");
}

export function createTrustedProxy(options: { host: string; lookup?: Lookup; intervalMs?: number; onError?: (error: unknown) => void }): TrustedProxy {
  const resolve = options.lookup ?? defaultLookup;
  let addresses = new Set<string>();
  let timer: NodeJS.Timeout | null = null;

  const refresh = async (): Promise<void> => {
    try {
      addresses = new Set((await resolve(options.host)).map(normalizeAddress));
    } catch (error) {
      // Keep the last known addresses: a lookup that fails now should not un-trust nginx.
      options.onError?.(error);
    }
  };

  return {
    trust: (address) => isLoopback(address) || addresses.has(normalizeAddress(address)),
    refresh,
    start: async (maxWaitMs = 3_000) => {
      timer ??= setInterval(() => { void refresh(); }, options.intervalMs ?? 15_000);
      timer.unref();
      let giveUp: NodeJS.Timeout | undefined;
      await Promise.race([refresh(), new Promise<void>((resolveWait) => { giveUp = setTimeout(resolveWait, maxWaitMs); })]);
      clearTimeout(giveUp);
    },
    stop: () => { if (timer) clearInterval(timer); timer = null; },
  };
}
