import { registerSW } from "virtual:pwa-register";

declare const __DEPLOY_COMMIT__: string;

const POLL_MS = 60_000;
const MAX_RETRY_MS = 5 * 60_000;
const initialVersion = __DEPLOY_COMMIT__;
let lastSuccessfulVersion = initialVersion;
let retryDelay = 5_000;
let checking = false;
let registration: ServiceWorkerRegistration | undefined;
let retryTimer: number | undefined;

// Other UI flows can dispatch this event when it becomes safe to reload.
// A pending terminal or destructive operation must not be interrupted.
const RELOAD_SAFE_EVENT = "stackport:pwa-reload-safe";

function isBusy(): boolean {
  return document.querySelector('[data-pwa-update-blocker="true"]') !== null;
}

function notifyPending(): void {
  window.dispatchEvent(new CustomEvent("stackport:pwa-update-pending"));
}

async function deployedVersion(): Promise<string | null> {
  try {
    const response = await fetch("/version.json", { cache: "no-store" });
    if (!response.ok) return null;
    const json: unknown = await response.json();
    if (!json || typeof json !== "object" || !("version" in json)) return null;
    const version = (json as { version: unknown }).version;
    return typeof version === "string" && version !== "unknown" && version.length > 0 ? version : null;
  } catch {
    return null;
  }
}

async function checkForUpdate(): Promise<void> {
  if (!registration || checking || !navigator.onLine) return;
  checking = true;
  try {
    const version = await deployedVersion();
    if (!version) return;
    if (version === lastSuccessfulVersion) return;
    // Don't mark a version as checked until the browser has successfully checked
    // its worker script. Failed requests must be retried.
    await registration.update();
    lastSuccessfulVersion = version;
    retryDelay = 5_000;
    if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    retryTimer = undefined;
  } catch {
    if (retryTimer === undefined) {
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        void checkForUpdate();
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
    }
  } finally {
    checking = false;
  }
}

export function registerPwa(): void {
  if (!("serviceWorker" in navigator)) return;
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      // In-progress operations can mark their root with data-pwa-update-blocker.
      if (isBusy()) {
        notifyPending();
        const reloadWhenSafe = () => {
          if (isBusy()) return;
          window.removeEventListener(RELOAD_SAFE_EVENT, reloadWhenSafe);
          void updateSW(true);
        };
        window.addEventListener(RELOAD_SAFE_EVENT, reloadWhenSafe);
      } else {
        void updateSW(true);
      }
    },
    onRegisteredSW(_url, registered) {
      if (!registered) return;
      registration = registered;
      void checkForUpdate();
      window.setInterval(() => void checkForUpdate(), POLL_MS);
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) void checkForUpdate();
      });
      window.addEventListener("online", () => void checkForUpdate());
    },
  });
}
