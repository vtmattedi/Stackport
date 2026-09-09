import { randomUUID } from "crypto";
import { Socket } from "socket.io";
import { startStream, stopStream, stopStreamsForSocket, type LogsStartResult } from "./dockerLogs";

export interface LogsStartPayload {
  containerId: string;
}
export type LogsStartAck = LogsStartResult;
export interface LogsStopPayload {
  sessionId: string;
}
export interface LogsDataEvent {
  sessionId: string;
  chunk: string;
}
export interface LogsExitEvent {
  sessionId: string;
  code: number | null;
  signal: string | null;
}

function isLogsStartPayload(value: unknown): value is LogsStartPayload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v["containerId"] === "string";
}

function isLogsStopPayload(value: unknown): value is LogsStopPayload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v["sessionId"] === "string";
}

export function bindDockerLogsEvents(socket: Socket): void {
  socket.on("logs:start", (payload: unknown, ack?: (res: LogsStartAck) => void) => {
    if (!isLogsStartPayload(payload)) {
      ack?.({ ok: false, error: "Invalid request" });
      return;
    }
    const sessionId = randomUUID();
    const result = startStream({
      sessionId,
      containerId: payload.containerId,
      username: socket.data["user"] as string,
      socketId: socket.id,
      onData: (chunk) => {
        const event: LogsDataEvent = { sessionId, chunk };
        socket.emit("logs:data", event);
      },
      onExit: (info) => {
        const event: LogsExitEvent = { sessionId, code: info.code, signal: info.signal };
        socket.emit("logs:exit", event);
      },
    });
    ack?.(result);
  });

  socket.on("logs:stop", (payload: unknown) => {
    if (!isLogsStopPayload(payload)) return;
    stopStream(payload.sessionId, socket.id);
  });

  socket.on("disconnect", () => {
    stopStreamsForSocket(socket.id);
  });
}
