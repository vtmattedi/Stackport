import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Loader, Radio, X } from "lucide-react";
import { Button } from "./ui/button";
import { useContainerLogStream } from "../hooks/useContainerLogStream";
import { notify } from "../lib/notify";
import type { ContainerInfo } from "../api/types";

interface ContainerLogDialogProps {
  container: ContainerInfo;
  onClose: () => void;
}

export function ContainerLogDialog({ container, onClose }: ContainerLogDialogProps) {
  const termContainerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const startedRef = useRef(false);

  const logs = useContainerLogStream({
    containerId: container.id,
    onData: (chunk) => termRef.current?.write(chunk),
    onExit: ({ code, signal }) => {
      const reason = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      termRef.current?.write(`\r\n\x1b[90m[log stream ended, ${reason}]\x1b[0m\r\n`);
    },
    onError: (message) => {
      notify.error(new Error(message), "Failed to open live logs");
      onClose();
    },
  });
  const logsRef = useRef(logs);
  logsRef.current = logs;

  useEffect(() => {
    const mountEl = termContainerRef.current;
    if (!mountEl) return;

    const term = new Terminal({
      convertEol: true,
      cursorBlink: false,
      disableStdin: true,
      fontSize: 13,
      fontFamily: "var(--mono)",
      theme: { background: "#000000" },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(mountEl);
    fitAddon.fit();
    termRef.current = term;

    if (!startedRef.current) {
      startedRef.current = true;
      logsRef.current.start();
    }

    return () => {
      term.dispose();
      termRef.current = null;
    };
  }, []);

  const handleClose = () => {
    logsRef.current.stop();
    onClose();
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") handleClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="confirm-backdrop" role="presentation" onMouseDown={handleClose}>
      <div
        className="shell-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`Live logs — ${container.service ?? container.name}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="shell-header">
          <Radio size={14} />
          <span className="shell-header-title mono">{container.service ?? container.name}</span>
          {logs.status === "open" && (
            <span className="shell-live-badge">
              <span className="shell-live-dot" />
              LIVE
            </span>
          )}
          {logs.status === "starting" && <Loader size={12} className="spin" />}
          <Button type="button" variant="ghost" size="icon-xs" onClick={handleClose} title="Close" aria-label="Close live logs">
            <X size={12} />
          </Button>
        </div>
        <div className="shell-term" ref={termContainerRef} />
      </div>
    </div>
  );
}
