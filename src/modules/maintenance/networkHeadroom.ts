import { dockerRun, type DockerRun } from "../ingress/networks";
import { cidrEnd, parseCidr } from "../../shared/cidr";

/**
 * How many more Docker networks fit (P3).
 *
 * Docker hands every network a slice of an address pool. With the stock settings that is
 * about 31 networks for the whole host, however many projects there are. When it runs out
 * `docker network create` fails, and so does the next deploy or start-up that needs a
 * network; in the 1.3.0 incident that took routed projects down. The fix is a larger pool
 * in `/etc/docker/daemon.json`, so this tells an admin how close they are.
 */

export interface AddressPool {
  /** CIDR, for example `172.17.0.0/16`. */
  base: string;
  /** Prefix length of each network carved out of it. */
  size: number;
}

/** What the daemon uses when `default-address-pools` is not set. */
export const DEFAULT_ADDRESS_POOLS: AddressPool[] = [
  // 172.17.0.0/16 to 172.31.0.0/16, one network each (172.16 is skipped), then 192.168.0.0/16 in /20 slices: 31 in all.
  ...Array.from({ length: 15 }, (_, i) => ({ base: `172.${17 + i}.0.0/16`, size: 16 })),
  { base: "192.168.0.0/16", size: 20 },
];

export type HeadroomLevel = "ok" | "warning" | "critical";

export interface NetworkHeadroom {
  /** Networks the pools can hold. */
  capacity: number;
  /** Slices in use. */
  used: number;
  free: number;
  level: HeadroomLevel;
  /** False when the daemon's own pools could not be read and the stock ones were assumed. */
  poolsKnown: boolean;
  pools: AddressPool[];
  /** What to do, present when the level is not ok. */
  advice: string | null;
}

/** Warn when this few remain, or when more than this share is used. */
const WARNING_FREE = 6;
const CRITICAL_FREE = 2;

/** How many networks of the pool's `size` fit in its base range. */
export function poolCapacity(pool: AddressPool): number {
  const base = parseCidr(pool.base);
  if (!base || pool.size < base.prefix || pool.size > 32) return 0;
  return 2 ** (pool.size - base.prefix);
}

/** Slices a subnet takes from the pools: none when it lies outside them (a network with its own
 *  range costs the pool nothing), otherwise one per pool-sized block it covers. */
export function slotsTaken(subnet: string, pools: AddressPool[]): number {
  const net = parseCidr(subnet);
  if (!net) return 0;
  for (const pool of pools) {
    const base = parseCidr(pool.base);
    if (!base) continue;
    if (net.start < base.start || cidrEnd(net) > cidrEnd(base)) continue;
    return net.prefix >= pool.size ? 1 : 2 ** (pool.size - net.prefix);
  }
  return 0;
}

export function computeHeadroom(pools: AddressPool[], subnets: string[], poolsKnown: boolean): NetworkHeadroom {
  const capacity = pools.reduce((sum, pool) => sum + poolCapacity(pool), 0);
  const used = Math.min(capacity, subnets.reduce((sum, subnet) => sum + slotsTaken(subnet, pools), 0));
  const free = capacity - used;
  const level: HeadroomLevel = free <= CRITICAL_FREE ? "critical" : free <= WARNING_FREE ? "warning" : "ok";
  return { capacity, used, free, level, poolsKnown, pools, advice: level === "ok" ? null : ADVICE };
}

const ADVICE = [
  "Docker gives every network a slice of a small default address pool, and a new network fails once it is used up.",
  "On the server run `sudo stackport network-pool set --base 10.20.0.0/14 --size 24`: it sets default-address-pools in /etc/docker/daemon.json",
  "(1024 networks) after checking the range against the host's own routes, and asks before restarting Docker. Existing networks keep their ranges.",
].join(" ");

interface DockerInfoPool { Base?: string; Size?: number }

import { SingleFlightCache } from "../../shared/singleFlightCache";

const headroomCache = new SingleFlightCache<NetworkHeadroom>(() => readNetworkHeadroom(), 30_000);

/** Cached for 30 seconds: a page that polls should not run `docker network inspect` on every request. */
export function getNetworkHeadroom(): Promise<NetworkHeadroom> {
  return headroomCache.get();
}

/** The daemon's address pools; the stock ones, with `known` false, when it will not say. */
export async function readAddressPools(run: DockerRun = dockerRun): Promise<{ pools: AddressPool[]; known: boolean }> {
  let pools = DEFAULT_ADDRESS_POOLS;
  let poolsKnown = false;
  try {
    const parsed = JSON.parse(await run(["info", "--format", "{{json .DefaultAddressPools}}"])) as DockerInfoPool[] | null;
    if (parsed && parsed.length) {
      pools = parsed.filter((p): p is { Base: string; Size: number } => typeof p.Base === "string" && typeof p.Size === "number").map((p) => ({ base: p.Base, size: p.Size }));
      poolsKnown = pools.length > 0;
    } else if (Array.isArray(parsed) || parsed === null) {
      // The daemon answered and has no custom pools (Docker prints null for an unset list), so the stock ones apply.
      // A daemon too old to have the field makes the command fail instead, which is caught below.
      poolsKnown = true;
    }
  } catch { /* keep the stock pools; poolsKnown says they are an assumption */ }
  if (!pools.length) { pools = DEFAULT_ADDRESS_POOLS; poolsKnown = false; }
  return { pools, known: poolsKnown };
}

/** The subnets of every network and the daemon's pools, as Docker reports them. */
export async function readNetworkHeadroom(run: DockerRun = dockerRun): Promise<NetworkHeadroom> {
  const { pools, known: poolsKnown } = await readAddressPools(run);
  const ids = (await run(["network", "ls", "--quiet"])).split(/\s+/).filter(Boolean);
  const subnets: string[] = [];
  if (ids.length) {
    const out = await run(["network", "inspect", ...ids, "--format", "{{range .IPAM.Config}}{{.Subnet}}\n{{end}}"]);
    for (const line of out.split(/\r?\n/)) if (line.trim()) subnets.push(line.trim());
  }
  return computeHeadroom(pools, subnets, poolsKnown);
}
