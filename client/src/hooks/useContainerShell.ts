import { useCallback, useEffect, useRef, useState } from "react";
import { useSocket } from "../context/SocketContext";
import type {
  ShellDataEvent,
  ShellExitEvent,
  ShellStartAck,
  ShellStartPayload,
  ShellStopPayload,
} from "../api/types";

export type ContainerShellStatus = "idle" | "starting" | "open" | "closed" | "error";

export interface UseContainerShellOptions {
  containerId: string;
  onData: (chunk: string) => void;
  onExit: (info: { code: number | null; signal: string | null }) => void;
  onError: (message: string) => void;
}

export interface UseContainerShellApi {
  status: ContainerShellStatus;
  start: (cols: number, rows: number) => void;
  write: (data: string) => void;
  stop: () => void;
}

export function useContainerShell(opts: UseContainerShellOptions): UseContainerShellApi {
  const { connected, emit, emitWithAck, on, off } = useSocket();
  const [status, setStatus] = useState<ContainerShellStatus>("idle");
  const sessionIdRef = useRef<string | null>(null);

  const containerIdRef = useRef(opts.containerId);
  containerIdRef.current = opts.containerId;
  const onDataRef = useRef(opts.onData);
  onDataRef.current = opts.onData;
  const onExitRef = useRef(opts.onExit);
  onExitRef.current = opts.onExit;
  const onErrorRef = useRef(opts.onError);
  onErrorRef.current = opts.onError;

  const start = useCallback((cols: number, rows: number) => {
    setStatus("starting");
    const payload: ShellStartPayload = { containerId: containerIdRef.current, cols, rows };
    emitWithAck<ShellStartAck>("shell:start", payload)
      .then((result) => {
        if (result.ok) {
          sessionIdRef.current = result.sessionId;
          setStatus("open");
        } else {
          setStatus("error");
          onErrorRef.current(result.error);
        }
      })
      .catch((err: Error) => {
        setStatus("error");
        onErrorRef.current(err.message || "Failed to open shell");
      });
  }, [emitWithAck]);

  const write = useCallback((data: string) => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    emit("shell:input", { sessionId, data });
  }, [emit]);

  const stop = useCallback(() => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    const payload: ShellStopPayload = { sessionId };
    emit("shell:stop", payload);
  }, [emit]);

  useEffect(() => {
    const handleData = (event: ShellDataEvent) => {
      if (event.sessionId !== sessionIdRef.current) return;
      onDataRef.current(event.chunk);
    };
    const handleExit = (event: ShellExitEvent) => {
      if (event.sessionId !== sessionIdRef.current) return;
      sessionIdRef.current = null;
      setStatus("closed");
      onExitRef.current({ code: event.code, signal: event.signal });
    };
    on<ShellDataEvent>("shell:data", handleData);
    on<ShellExitEvent>("shell:exit", handleExit);
    return () => {
      off<ShellDataEvent>("shell:data", handleData);
      off<ShellExitEvent>("shell:exit", handleExit);
      const sessionId = sessionIdRef.current;
      if (sessionId) {
        emit("shell:stop", { sessionId } satisfies ShellStopPayload);
        sessionIdRef.current = null;
      }
    };
  }, [on, off, emit]);

  useEffect(() => {
    if (connected) return;
    if (!sessionIdRef.current) return;
    sessionIdRef.current = null;
    setStatus("closed");
    onExitRef.current({ code: null, signal: null });
  }, [connected]);

  return { status, start, write, stop };
}
