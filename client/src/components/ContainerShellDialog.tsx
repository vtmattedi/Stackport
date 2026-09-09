import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Loader, SquareTerminal, X } from "lucide-react";
import { Button } from "./ui/button";
import { useContainerShell } from "../hooks/useContainerShell";
import { notify } from "../lib/notify";
import type { ContainerInfo } from "../api/types";

interface ContainerShellDialogProps {
  container: ContainerInfo;
  onClose: () => void;
}

export function ContainerShellDialog({ container, onClose }: ContainerShellDialogProps) {
  const termContainerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const startedRef = useRef(false);

  const shell = useContainerShell({
    containerId: container.id,
    onData: (chunk) => termRef.current?.write(chunk),
    onExit: ({ code, signal }) => {
      const reason = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      termRef.current?.write(`\r\n\x1b[90m[process exited, ${reason}]\x1b[0m\r\n`);
    },
    onError: (message) => {
      notify.error(new Error(message), "Failed to open shell");
      onClose();
    },
  });
  const shellRef = useRef(shell);
  shellRef.current = shell;

  useEffect(() => {
    const mountEl = termContainerRef.current;
    if (!mountEl) return;

    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
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
      const dims = fitAddon.proposeDimensions() ?? { cols: 80, rows: 24 };
      shellRef.current.start(dims.cols, dims.rows);
    }

    // The remote shell has a real pty (see dockerShell.ts), so it handles its
    // own echo, line editing, and signal delivery — just forward raw bytes.
    const dataSub = term.onData((data) => shellRef.current.write(data));

    return () => {
      dataSub.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, []);

  const handleClose = () => {
    shellRef.current.stop();
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
        aria-label={`Shell — ${container.service ?? container.name}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="shell-header">
          <SquareTerminal size={14} />
          <span className="shell-header-title mono">{container.service ?? container.name}</span>
          {shell.status === "starting" && <Loader size={12} className="spin" />}
          <Button type="button" variant="ghost" size="icon-xs" onClick={handleClose} title="Close" aria-label="Close shell">
            <X size={12} />
          </Button>
        </div>
        <div className="shell-term" ref={termContainerRef} />
      </div>
    </div>
  );
}
