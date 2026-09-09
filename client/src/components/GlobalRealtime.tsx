import { useEffect, useRef } from "react";
import { notify } from "../lib/notify";
import { truncateLabel } from "../lib/format";
import { useSocket } from "../context/SocketContext";
import type { GlobalRealtimeEvent } from "../api/types";

type ToastId = string | number;

function toastTitle(event: GlobalRealtimeEvent): string {
  return event.projectName ? `${truncateLabel(event.projectName)}: ${event.title}` : event.title;
}

export function GlobalRealtime() {
  const { subscribeGlobal, unsubscribeGlobal } = useSocket();
  const toastIds = useRef(new Map<string, ToastId>());
  // Latest step text already shown per self-build flow, so a toast update only
  // fires when the step actually changes — not on every raw stdout/stderr chunk.
  const lastStep = useRef(new Map<string, string | undefined>());

  useEffect(() => {
    // Generic start/success/failed toast lifecycle — used for nginx apply and docker prune flows.
    function handleFlowEvent(event: GlobalRealtimeEvent) {
      const existingToast = toastIds.current.get(event.id);
      const title = toastTitle(event);
      if (event.status === "started") {
        const toastId = notify.loading(title, {
          id: existingToast,
          description: event.message,
        });
        toastIds.current.set(event.id, toastId);
        return;
      }

      if (event.status === "success") {
        notify.success(title, {
          id: existingToast,
          description: event.message,
        });
        toastIds.current.delete(event.id);
        return;
      }

      notify.error(new Error(event.output || event.message), title, {
        id: existingToast,
        description: event.message,
      });
      toastIds.current.delete(event.id);
    }

    // Self-build (git pull, backup/restore, install, build, restart) — surfaced
    // app-wide so it's visible even off the Settings page. Intentionally has no
    // cancel action: it's rewriting the running app's own code, so interrupting
    // it mid-flight can leave the service half-updated or unable to restart.
    function handleSystemUpdate(event: GlobalRealtimeEvent) {
      const existingToast = toastIds.current.get(event.id);

      if (event.status === "started") {
        const toastId = notify.loading(event.title, {
          id: existingToast,
          description: event.step ?? event.message,
        });
        toastIds.current.set(event.id, toastId);
        lastStep.current.set(event.id, event.step);
        return;
      }

      if (event.status === "running") {
        if (event.step && event.step !== lastStep.current.get(event.id)) {
          lastStep.current.set(event.id, event.step);
          notify.loading(event.title, { id: existingToast, description: event.step });
        }
        return;
      }

      lastStep.current.delete(event.id);
      if (event.status === "success") {
        notify.success(event.title, { id: existingToast, description: event.message });
      } else {
        notify.error(new Error(event.output || event.message), event.title, { id: existingToast, description: event.message });
      }
      toastIds.current.delete(event.id);
    }

    function handleGlobalEvent(event: GlobalRealtimeEvent) {
      if (event.type === "nginx:flow" || event.type === "docker:flow") { handleFlowEvent(event); return; }
      if (event.type === "system:update") { handleSystemUpdate(event); return; }
    }

    subscribeGlobal<GlobalRealtimeEvent>(handleGlobalEvent);
    return () => unsubscribeGlobal<GlobalRealtimeEvent>(handleGlobalEvent);
  }, [subscribeGlobal, unsubscribeGlobal]);

  return null;
}
