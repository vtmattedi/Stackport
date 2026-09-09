import { useCallback, useEffect, useRef, useState } from "react";
import { useSocket } from "../context/SocketContext";
import type {
  LogsDataEvent,
  LogsExitEvent,
  LogsStartAck,
  LogsStartPayload,
  LogsStopPayload,
} from "../api/types";

export type ContainerLogStreamStatus = "idle" | "starting" | "open" | "closed" | "error";

export interface UseContainerLogStreamOptions {
  containerId: string;
  onData: (chunk: string) => void;
  onExit: (info: { code: number | null; signal: string | null }) => void;
  onError: (message: string) => void;
}

export interface UseContainerLogStreamApi {
  status: ContainerLogStreamStatus;
  start: () => void;
  stop: () => void;
}

export function useContainerLogStream(opts: UseContainerLogStreamOptions): UseContainerLogStreamApi {
  const { connected, emit, emitWithAck, on, off } = useSocket();
  const [status, setStatus] = useState<ContainerLogStreamStatus>("idle");
  const sessionIdRef = useRef<string | null>(null);

  const containerIdRef = useRef(opts.containerId);
  containerIdRef.current = opts.containerId;
  const onDataRef = useRef(opts.onData);
  onDataRef.current = opts.onData;
  const onExitRef = useRef(opts.onExit);
  onExitRef.current = opts.onExit;
  const onErrorRef = useRef(opts.onError);
  onErrorRef.current = opts.onError;

  const start = useCallback(() => {
    setStatus("starting");
    const payload: LogsStartPayload = { containerId: containerIdRef.current };
    emitWithAck<LogsStartAck>("logs:start", payload)
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
        onErrorRef.current(err.message || "Failed to open log stream");
      });
  }, [emitWithAck]);

  const stop = useCallback(() => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    const payload: LogsStopPayload = { sessionId };
    emit("logs:stop", payload);
  }, [emit]);

  useEffect(() => {
    const handleData = (event: LogsDataEvent) => {
      if (event.sessionId !== sessionIdRef.current) return;
      onDataRef.current(event.chunk);
    };
    const handleExit = (event: LogsExitEvent) => {
      if (event.sessionId !== sessionIdRef.current) return;
      sessionIdRef.current = null;
      setStatus("closed");
      onExitRef.current({ code: event.code, signal: event.signal });
    };
    on<LogsDataEvent>("logs:data", handleData);
    on<LogsExitEvent>("logs:exit", handleExit);
    return () => {
      off<LogsDataEvent>("logs:data", handleData);
      off<LogsExitEvent>("logs:exit", handleExit);
      const sessionId = sessionIdRef.current;
      if (sessionId) {
        emit("logs:stop", { sessionId } satisfies LogsStopPayload);
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

  return { status, start, stop };
}
