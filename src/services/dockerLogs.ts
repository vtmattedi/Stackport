import { spawn, type ChildProcessByStdio } from "child_process";
import type { Readable } from "stream";
import { CONTAINER_REF_RE } from "../routes/system";
import { auditLog } from "../utils/logger";

const MAX_TOTAL_SESSIONS = 20;
const MAX_SESSIONS_PER_USER = 4;
const MAX_SESSION_DURATION_MS = 4 * 60 * 60_000; // 4h hard cap, defense-in-depth
const KILL_GRACE_MS = 5_000;
const TAIL_LINES = 200;

interface LogSession {
  containerId: string;
  username: string;
  socketId: string;
  child: ChildProcessByStdio<null, Readable, Readable>;
  createdAt: number;
  hardTimer: NodeJS.Timeout;
}

export interface LogsStartArgs {
  sessionId: string;
  containerId: string;
  username: string;
  socketId: string;
  onData: (chunk: string) => void;
  onExit: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
}

export type LogsStartResult = { ok: true; sessionId: string } | { ok: false; error: string };

const sessions = new Map<string, LogSession>();

export function startStream(args: LogsStartArgs): LogsStartResult {
  if (!CONTAINER_REF_RE.test(args.containerId)) {
    return { ok: false, error: "Invalid container id" };
  }
  if (sessions.size >= MAX_TOTAL_SESSIONS) {
    return { ok: false, error: "Too many active log streams on the server, try again later" };
  }
  const userSessionCount = Array.from(sessions.values()).filter((s) => s.username === args.username).length;
  if (userSessionCount >= MAX_SESSIONS_PER_USER) {
    return { ok: false, error: "Too many active log streams for your user" };
  }

  // Unprivileged, like every other docker call in system.ts — the app's
  // system user is in the `docker` group (see init.sh). No TTY needed for
  // log streaming, so no `script` wrapper required here (unlike dockerShell.ts).
  const child = spawn(
    "docker",
    ["logs", "-f", "--timestamps", "--tail", String(TAIL_LINES), args.containerId],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  const sessionId = args.sessionId;

  const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
    const session = sessions.get(sessionId);
    if (!session) return;
    clearTimeout(session.hardTimer);
    sessions.delete(sessionId);
    auditLog(args.username, "system.logs-stream-close", args.containerId, "ok", { sessionId, code, signal });
    args.onExit({ code, signal });
  };

  child.stdout.on("data", (chunk: Buffer) => args.onData(chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => args.onData(chunk.toString("utf8")));
  child.on("error", () => finish(null, null));
  child.on("close", (code, signal) => finish(code, signal));

  const hardTimer = setTimeout(() => stopStream(sessionId), MAX_SESSION_DURATION_MS).unref();

  sessions.set(sessionId, {
    containerId: args.containerId,
    username: args.username,
    socketId: args.socketId,
    child,
    createdAt: Date.now(),
    hardTimer,
  });

  auditLog(args.username, "system.logs-stream-open", args.containerId, "ok", { sessionId });
  return { ok: true, sessionId };
}

export function stopStream(sessionId: string, socketId?: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  if (socketId !== undefined && session.socketId !== socketId) return false;
  session.child.kill("SIGTERM");
  setTimeout(() => {
    if (sessions.has(sessionId)) session.child.kill("SIGKILL");
  }, KILL_GRACE_MS).unref();
  return true;
}

export function stopStreamsForSocket(socketId: string): void {
  for (const [sessionId, session] of sessions) {
    if (session.socketId === socketId) stopStream(sessionId);
  }
}
