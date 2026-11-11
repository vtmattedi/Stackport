/* eslint-disable security/detect-non-literal-fs-filename -- every path is one of two directories (the app's request directory beside its database, and the host's read-only state mount) plus a fixed file name. */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { config } from "../../config/env";
import { actionRegistry } from "../actions/registry";
import { dockerRun, type DockerRun } from "../ingress/networks";

/**
 * Rebooting the host from Host > Power.
 *
 * Stackport runs in a container with no way to reboot the machine, and is not given one. It writes a signed request file into its
 * data directory (`power/reboot-request`); a systemd path unit that `stackport install` or `repair` sets up on the host notices it
 * and runs `stackport power-run`, which reads the file as the app's own user, checks the signature, the age and the shape, and then
 * schedules `shutdown -r`. The signing key is STACKPORT_POWER_KEY (root-only `secrets.env` on the host, and in this process's
 * environment), so a file written by anything else is refused. The shell side is `power_verify` in stackport.sh: the two must sign
 * the same string.
 *
 * The data directory belongs to this process, so the host never writes into it. What the host has to say back (the units are installed,
 * the schedule, the last refusal) is in a root-owned directory the container mounts read-only (`/app/power-state`).
 */

export const MAX_DELAY_MINUTES = 60;
/** The host refuses a request older than this (stackport.sh POWER_MAX_AGE_S); past it a request file is stale, not pending. */
export const REQUEST_MAX_AGE_S = 300;

export type PowerAction = "reboot" | "cancel";

export class PowerError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export interface PowerDirs {
  /** Where requests are written: the app's own directory. */
  requests: string;
  /** What the host wrote: read-only here. */
  state: string;
  key: string;
}

export function defaultPowerDirs(): PowerDirs {
  return { requests: path.join(path.dirname(path.resolve(config.sqlitePath)), "power"), state: config.powerStateDir, key: config.powerKey };
}

/** HMAC-SHA256 (hex) over "action|requested_at|by|delay_min", the same string `power_mac` signs in stackport.sh. */
export function signPowerRequest(key: string, action: PowerAction, requestedAt: number, by: string, delayMinutes: number): string {
  return crypto.createHmac("sha256", key).update(`${action}|${requestedAt}|${by}|${delayMinutes}`).digest("hex");
}

/** A name the host will accept in `by`: letters, digits, dot, underscore, hyphen, at most 40. */
export function powerRequester(user: string | undefined): string {
  const cleaned = (user ?? "").replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 40);
  return cleaned || "admin";
}

export function powerRequestBody(key: string, action: PowerAction, requestedAt: number, by: string, delayMinutes: number): string {
  return [
    `action=${action}`,
    `requested_at=${requestedAt}`,
    `by=${by}`,
    `delay_min=${delayMinutes}`,
    `mac=${signPowerRequest(key, action, requestedAt, by, delayMinutes)}`,
    "",
  ].join("\n");
}

/** What the host will do: a reboot at a time, or nothing because the last request was a cancel. */
export interface HostSchedule {
  state: "scheduled" | "cancelled" | "unknown";
  /** Unix seconds when the host recorded it. */
  at: number | null;
  /** Unix seconds when the machine will reboot, for a scheduled reboot. */
  rebootAt: number | null;
  by: string | null;
}

/** The last request the host refused or could not carry out. Kept apart from the schedule, so a refusal never hides a reboot that is still ahead. */
export interface HostError {
  state: "rejected" | "failed";
  at: number | null;
  detail: string | null;
}

function keyValues(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at > 0) values[line.slice(0, at)] = line.slice(at + 1);
  }
  return values;
}
const seconds = (value: string | undefined): number | null => (value && /^\d{1,12}$/.test(value) ? Number(value) : null);

export function parseHostSchedule(text: string): HostSchedule {
  const values = keyValues(text);
  const state = (["scheduled", "cancelled"] as const).find((s) => s === values["state"]) ?? "unknown";
  return { state, at: seconds(values["at"]), rebootAt: seconds(values["reboot_at"]), by: values["by"] ?? null };
}

export function parseHostError(text: string): HostError | null {
  const values = keyValues(text);
  const state = (["rejected", "failed"] as const).find((s) => s === values["state"]);
  return state ? { state, at: seconds(values["at"]), detail: values["detail"] ?? null } : null;
}

export interface PowerState {
  /** The host side is installed and this process can sign requests. */
  available: boolean;
  /** Why not, with what to do about it. */
  unavailableReason: string | null;
  /** A request has been written, is recent, and the host has not picked it up yet. */
  requestPending: boolean;
  /** A request file is older than the host would accept and is still there: the host is not picking requests up. */
  requestStale: boolean;
  /** What the host will do. */
  schedule: HostSchedule | null;
  /** The last request the host refused, when that is newer than the schedule. */
  lastError: HostError | null;
  /** True while a reboot is scheduled and still ahead. */
  rebootScheduled: boolean;
}

const REQUEST_FILES = ["reboot-request", "cancel-request"] as const;

function requestAge(dir: string, name: string, now: number): number | null {
  try { return (now - fs.statSync(path.join(dir, name)).mtimeMs) / 1000; } catch { return null; }
}

export function readPowerState(now: number = Date.now(), dirs: PowerDirs = defaultPowerDirs()): PowerState {
  const stateFile = (name: string): string | null => { try { return fs.readFileSync(path.join(dirs.state, name), "utf8"); } catch { return null; } };
  let unavailableReason: string | null = null;
  if (!dirs.key) unavailableReason = "This instance has no power key yet. Run `sudo stackport repair` on the server (it adds the key and recreates Stackport).";
  else if (stateFile("ready") === null) unavailableReason = "The host side is not set up. Run `sudo stackport repair` on the server, or use `sudo stackport reboot` over SSH.";
  const scheduleText = stateFile("status");
  const schedule = scheduleText === null ? null : parseHostSchedule(scheduleText);
  const errorText = stateFile("last-error");
  const error = errorText === null ? null : parseHostError(errorText);
  const rebootScheduled = schedule?.state === "scheduled" && schedule.rebootAt !== null && schedule.rebootAt * 1000 > now;
  const ages = REQUEST_FILES.map((name) => requestAge(dirs.requests, name, now)).filter((age): age is number => age !== null);
  return {
    available: unavailableReason === null,
    unavailableReason,
    requestPending: ages.some((age) => age <= REQUEST_MAX_AGE_S + 30),
    requestStale: ages.some((age) => age > REQUEST_MAX_AGE_S + 30),
    schedule,
    lastError: error && (error.at ?? 0) >= (schedule?.at ?? 0) ? error : null,
    rebootScheduled,
  };
}

function writeRequest(action: PowerAction, by: string, delayMinutes: number, now: number, dirs: PowerDirs): void {
  fs.mkdirSync(dirs.requests, { recursive: true });
  // A request the host never picked up and would refuse as stale is the app's own file: clear it so it cannot block the next one.
  for (const name of REQUEST_FILES) if ((requestAge(dirs.requests, name, now) ?? 0) > REQUEST_MAX_AGE_S + 30) fs.rmSync(path.join(dirs.requests, name), { force: true });
  const body = powerRequestBody(dirs.key, action, Math.floor(now / 1000), by, delayMinutes);
  // Written aside and renamed, so the host never reads half a file.
  const tmp = path.join(dirs.requests, `.${action}-${crypto.randomBytes(4).toString("hex")}.tmp`);
  fs.writeFileSync(tmp, body, { mode: 0o644 });
  fs.renameSync(tmp, path.join(dirs.requests, `${action}-request`));
}

export function requestReboot(user: string | undefined, delayMinutes: unknown, now: number = Date.now(), dirs: PowerDirs = defaultPowerDirs()): PowerState {
  if (typeof delayMinutes !== "number" || !Number.isInteger(delayMinutes) || delayMinutes < 0 || delayMinutes > MAX_DELAY_MINUTES) {
    throw new PowerError(400, `delayMinutes must be a whole number from 0 to ${MAX_DELAY_MINUTES}`);
  }
  const state = readPowerState(now, dirs);
  if (!state.available) throw new PowerError(409, state.unavailableReason ?? "Host > Power is not available.");
  if (state.requestPending) throw new PowerError(409, "A request is already waiting for the host.");
  if (state.rebootScheduled) throw new PowerError(409, "A reboot is already scheduled. Cancel it first.");
  writeRequest("reboot", powerRequester(user), delayMinutes, now, dirs);
  return readPowerState(now, dirs);
}

export function requestCancel(user: string | undefined, now: number = Date.now(), dirs: PowerDirs = defaultPowerDirs()): PowerState {
  const state = readPowerState(now, dirs);
  if (!state.available) throw new PowerError(409, state.unavailableReason ?? "Host > Power is not available.");
  if (!state.rebootScheduled) throw new PowerError(409, "No reboot is scheduled.");
  writeRequest("cancel", powerRequester(user), 0, now, dirs);
  return readPowerState(now, dirs);
}

export interface PowerPreflight {
  /** Deploys, builds and the like that a reboot would cut off. */
  runningActions: { id: string; kind: string; key: string; startedAt: string }[];
  runningContainers: number;
  /** Running containers with no restart policy: they stay stopped after the reboot. */
  containersWithoutRestart: string[];
  /** False when Docker could not be asked; the lists above are then incomplete. */
  dockerRead: boolean;
}

export async function readPowerPreflight(run: DockerRun = dockerRun): Promise<PowerPreflight> {
  const runningActions = actionRegistry.running().map(({ id, kind, key, startedAt }) => ({ id, kind, key, startedAt }));
  try {
    const ids = (await run(["ps", "--quiet"])).split(/\s+/).filter(Boolean);
    const without: string[] = [];
    if (ids.length) {
      const out = await run(["inspect", ...ids, "--format", "{{.Name}} {{.HostConfig.RestartPolicy.Name}}"]);
      for (const line of out.split(/\r?\n/)) {
        const [name, policy] = line.trim().split(/\s+/);
        if (name && (!policy || policy === "no")) without.push(name.replace(/^\//, ""));
      }
    }
    return { runningActions, runningContainers: ids.length, containersWithoutRestart: without.sort(), dockerRead: true };
  } catch {
    return { runningActions, runningContainers: 0, containersWithoutRestart: [], dockerRead: false };
  }
}
