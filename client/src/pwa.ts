import { registerSW } from "virtual:pwa-register";

const VERSION_POLL_INTERVAL_MS = 5 * 60_000;

async function fetchDeployedVersion(): Promise<string | null> {
  try {
    const res = await fetch("/version.json", { cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

// bump-version.cjs writes public/version.json on every build. There's no
// controlling TTY-equivalent push here — we just poll it, and when it
// changes, ask the already-installed service worker to check for a new one.
// registerType: "autoUpdate" takes it from there (installs + activates the
// new worker and reloads controlled clients without prompting).
function watchForNewVersion(onNewVersion: () => void): void {
  let lastVersion: string | null = null;
  window.setInterval(() => {
    void fetchDeployedVersion().then((version) => {
      if (!version) return;
      if (lastVersion && version !== lastVersion) onNewVersion();
      lastVersion = version;
    });
  }, VERSION_POLL_INTERVAL_MS);
}

export function registerPwa(): void {
  if (!("serviceWorker" in navigator)) return;
  registerSW({
    immediate: true,
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;
      watchForNewVersion(() => {
        void registration.update();
      });
    },
  });
}
