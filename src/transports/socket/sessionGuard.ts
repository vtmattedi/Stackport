import { isSessionLive } from "../../modules/identity/sessions";

/** A WebSocket is authenticated once, when it connects, but it can stay open for days. These checks
 *  close it when the session behind it is gone: expired, past its absolute cap, logged out or revoked.
 *  Privileged events (a shell in a container, container logs) check before they act; a sweep closes
 *  the rest. */

export interface GuardedSocket {
  data: Record<string, unknown>;
  emit(event: string, payload?: unknown): unknown;
  disconnect(close?: boolean): unknown;
}

/** True while the socket's session is valid; otherwise tells the client and closes it. */
export function socketSessionIsLive(socket: GuardedSocket, live: (tokenId: string) => boolean = isSessionLive): boolean {
  const tokenId = socket.data["authTokenId"];
  if (typeof tokenId === "string" && live(tokenId)) return true;
  socket.emit("auth:revoked", { reason: "session-ended" });
  socket.disconnect(true);
  return false;
}

/** Closes every socket whose session has ended. Returns how many it closed. */
export function sweepEndedSessions(sockets: Iterable<GuardedSocket>, live: (tokenId: string) => boolean = isSessionLive): number {
  let closed = 0;
  for (const socket of [...sockets]) if (!socketSessionIsLive(socket, live)) closed += 1;
  return closed;
}
