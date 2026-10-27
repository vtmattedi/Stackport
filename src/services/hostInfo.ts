/* eslint-disable security/detect-non-literal-fs-filename -- paths are the fixed host mounts from config (or a test directory) plus interface names listed from that same directory */
import { readdir, readFile, stat, statfs } from "fs/promises";
import * as os from "os";
import * as path from "path";
import { config } from "../config/env";

/** Host facts a container can't see on its own, read from the read-only mounts in
 *  docker-compose.system.yml. CPU, memory, load and uptime need nothing: the kernel
 *  files behind `os` aren't namespaced, so they already describe the host. */

/** The host's name; the container's own (its id) when /etc/hostname isn't mounted. */
export async function readHostname(file = config.hostHostnamePath): Promise<string> {
  try {
    const name = (await readFile(file, "utf8")).trim();
    if (name) return name;
  } catch { /* not mounted */ }
  return os.hostname();
}

export interface NetworkTotals {
  rxBytes: number;
  txBytes: number;
  interfaces: string[];
}

const VIRTUAL_NAME_RE = /^(lo|veth|docker|br-|virbr|vnet|tun|tap|ifb|cni|flannel|cali|weave|kube)/;

async function readCounter(file: string): Promise<number | null> {
  try {
    const value = Number((await readFile(file, "utf8")).trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** Byte counters summed over the host's physical interfaces: those backed by a device
 *  (`<iface>/device` exists), so Docker's bridges and veth pairs, which carry the same
 *  traffic again, aren't counted twice. If no interface has a device link, every
 *  interface whose name isn't a known virtual kind. Null when the host's /sys isn't
 *  mounted: the container's own /sys would only show the container's interface. */
export async function readNetworkTotals(sysPath = config.hostSysPath): Promise<NetworkTotals | null> {
  const netDir = path.join(sysPath, "class", "net");
  let names: string[];
  try {
    names = await readdir(netDir);
  } catch {
    return null;
  }

  const withDevice: string[] = [];
  for (const name of names) {
    if (await stat(path.join(netDir, name, "device")).then(() => true, () => false)) withDevice.push(name);
  }
  const chosen = withDevice.length > 0 ? withDevice : names.filter((name) => !VIRTUAL_NAME_RE.test(name));

  let rxBytes = 0;
  let txBytes = 0;
  const interfaces: string[] = [];
  for (const name of chosen) {
    const rx = await readCounter(path.join(netDir, name, "statistics", "rx_bytes"));
    const tx = await readCounter(path.join(netDir, name, "statistics", "tx_bytes"));
    if (rx === null || tx === null) continue;
    rxBytes += rx;
    txBytes += tx;
    interfaces.push(name);
  }
  return interfaces.length > 0 ? { rxBytes, txBytes, interfaces } : null;
}

export interface DiskSpace {
  freeBytes: number;
  totalBytes: number;
}

/** Free and total space of the filesystem holding `dir`. */
export async function readDiskSpace(dir: string): Promise<DiskSpace | null> {
  try {
    const stats = await statfs(dir);
    return { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize };
  } catch {
    return null;
  }
}

/** The filesystem Docker stores images, containers and volumes on: through the
 *  mounted data root when present, else `dockerRoot` itself (a native install, where
 *  the path is real). */
export async function readDockerRootDiskSpace(dockerRoot: string | null): Promise<DiskSpace | null> {
  return (await readDiskSpace(config.hostDockerRootPath)) ?? (dockerRoot ? readDiskSpace(dockerRoot) : null);
}
