import { randomUUID } from "crypto";
import { Socket } from "socket.io";
import { startSession, writeToSession, stopSession, stopSessionsForSocket, type ShellStartResult } from "./dockerShell";

export interface ShellStartPayload {
  containerId: string;
  cols: number;
  rows: number;
}
export type ShellStartAck = ShellStartResult;
export interface ShellInputPayload {
  sessionId: string;
  data: string;
}
export interface ShellStopPayload {
  sessionId: string;
}
export interface ShellDataEvent {
  sessionId: string;
  chunk: string;
}
export interface ShellExitEvent {
  sessionId: string;
  code: number | null;
  signal: string | null;
}

function isShellStartPayload(value: unknown): value is ShellStartPayload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v["containerId"] === "string" && typeof v["cols"] === "number" && typeof v["rows"] === "number";
}

function isShellInputPayload(value: unknown): value is ShellInputPayload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v["sessionId"] === "string" && typeof v["data"] === "string";
}

function isShellStopPayload(value: unknown): value is ShellStopPayload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v["sessionId"] === "string";
}

export function bindDockerShellEvents(socket: Socket): void {
  socket.on("shell:start", (payload: unknown, ack?: (res: ShellStartAck) => void) => {
    if (!isShellStartPayload(payload)) {
      ack?.({ ok: false, error: "Invalid request" });
      return;
    }
    const sessionId = randomUUID();
    void startSession({
      sessionId,
      containerId: payload.containerId,
      cols: payload.cols,
      rows: payload.rows,
      username: socket.data["user"] as string,
      socketId: socket.id,
      onData: (chunk) => {
        const event: ShellDataEvent = { sessionId, chunk };
        socket.emit("shell:data", event);
      },
      onExit: (info) => {
        const event: ShellExitEvent = { sessionId, code: info.code, signal: info.signal };
        socket.emit("shell:exit", event);
      },
    }).then((result) => ack?.(result));
  });

  socket.on("shell:input", (payload: unknown) => {
    if (!isShellInputPayload(payload)) return;
    writeToSession(payload.sessionId, socket.id, payload.data);
  });

  socket.on("shell:stop", (payload: unknown) => {
    if (!isShellStopPayload(payload)) return;
    stopSession(payload.sessionId, socket.id);
  });

  socket.on("disconnect", () => {
    stopSessionsForSocket(socket.id);
  });
}
