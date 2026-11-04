import { api } from "../api/client";
import type { PushBrowser } from "../api/types";

const BROWSER_ID_KEY = "stackport_push_browser_id";
const REMOVE_PENDING_KEY = "stackport_push_remove_pending";
const BROWSER_ENABLED_KEY = "stackport_push_browser_enabled";

export interface BrowserPushState {
  id: number | null;
  local: boolean;
  registered: boolean;
  keyMismatch: boolean;
  removalPending: boolean;
}

function applicationKey(publicKey: string): Uint8Array<ArrayBuffer> {
  const raw = atob(publicKey.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - publicKey.length % 4) % 4));
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

function keyMatches(subscription: PushSubscription, publicKey: string): boolean {
  const previous = subscription.options.applicationServerKey;
  if (!previous) return true;
  const expected = applicationKey(publicKey);
  const actual = new Uint8Array(previous);
  return actual.length === expected.length && actual.every((byte, index) => byte === expected[index]);
}

export function supportsBrowserPush(): boolean {
  return window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export function browserPushPermission(): NotificationPermission | "unsupported" {
  return supportsBrowserPush() ? Notification.permission : "unsupported";
}

export function currentPushBrowserId(): number | null {
  const id = Number(localStorage.getItem(BROWSER_ID_KEY));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function worker(): Promise<ServiceWorkerRegistration> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("The service worker is not ready. Reload Stackport and try again.")), 10_000); }),
    ]);
  } finally { if (timeout) clearTimeout(timeout); }
}

export async function hasLocalPushSubscription(): Promise<boolean> {
  if (!supportsBrowserPush()) return false;
  const registration = await navigator.serviceWorker.getRegistration();
  return !!(await registration?.pushManager.getSubscription());
}

/** Resolve the browser's actual capability through the authenticated API. A cached
 *  numeric ID is only a hint, never evidence that a restored DB knows this browser. */
export async function reconcileBrowserPush(publicKey: string): Promise<BrowserPushState> {
  const empty = { id: null, local: false, registered: false, keyMismatch: false, removalPending: false };
  if (!supportsBrowserPush()) return empty;
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) {
    localStorage.removeItem(BROWSER_ID_KEY);
    localStorage.removeItem(REMOVE_PENDING_KEY);
    return empty;
  }
  const removalPending = localStorage.getItem(REMOVE_PENDING_KEY) === "1";
  const server = await api.resolvePushBrowser(subscription.toJSON());
  const keyMismatch = !keyMatches(subscription, publicKey);
  if (server) localStorage.setItem(BROWSER_ID_KEY, String(server.id));
  else if (!removalPending) localStorage.removeItem(BROWSER_ID_KEY);
  return { id: server?.id ?? (removalPending ? currentPushBrowserId() : null), local: true,
    registered: !!server && !keyMismatch && !removalPending, keyMismatch, removalPending };
}

/** Passive check for browsers that opted in; never prompts or repairs automatically. */
export async function browserPushRecoveryNeeded(): Promise<boolean> {
  if (!supportsBrowserPush()) return false;
  const expected = currentPushBrowserId() !== null || localStorage.getItem(BROWSER_ENABLED_KEY) === "1";
  if (!expected && !await hasLocalPushSubscription()) return false;
  const config = await api.getPushConfig();
  if (!config.enabled) return false;
  // Keep intent even if reconciliation clears a stale numeric ID after expiry.
  if (expected) localStorage.setItem(BROWSER_ENABLED_KEY, "1");
  const state = await reconcileBrowserPush(config.vapidPublicKey);
  if (state.removalPending) return false;
  if (state.local) localStorage.setItem(BROWSER_ENABLED_KEY, "1");
  return (expected || state.local) && (!state.registered || browserPushPermission() !== "granted");
}

/** Called directly from a click: the permission prompt precedes any async fetch. */
export async function enableBrowserPush(publicKey: string, label: string): Promise<PushBrowser> {
  if (!supportsBrowserPush()) throw new Error("Browser push is not supported here. Use HTTPS and a browser with Web Push support.");
  if (localStorage.getItem(REMOVE_PENDING_KEY)) throw new Error("Finish disabling this browser before registering it again.");
  if (Notification.permission === "denied") throw new Error("Notifications are blocked. Allow them in your browser's site settings, then try again.");
  const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notification permission was not granted.");
  const registration = await worker();
  const applicationServerKey = applicationKey(publicKey);
  let subscription = await registration.pushManager.getSubscription();
  // A restored installation can have a different identity; replace stale local keys.
  if (subscription && !keyMatches(subscription, publicKey)) {
    const old = await api.resolvePushBrowser(subscription.toJSON());
    if (old) await api.removePushBrowser(old.id);
    if (!await subscription.unsubscribe()) throw new Error("Could not replace the old browser subscription. Try again.");
    subscription = null;
  }
  const created = !subscription;
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
  try {
    const browser = await api.savePushBrowser({ ...subscription.toJSON(), label: label.trim() || "Browser" });
    localStorage.setItem(BROWSER_ID_KEY, String(browser.id));
    localStorage.setItem(BROWSER_ENABLED_KEY, "1");
    return browser;
  } catch (error) {
    if (created) await subscription.unsubscribe().catch(() => undefined);
    throw error;
  }
}

export async function disableBrowserPush(id: number): Promise<void> {
  let local: PushSubscription | null = null;
  if (supportsBrowserPush()) {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    const actual = subscription ? await api.resolvePushBrowser(subscription.toJSON()) : null;
    if (actual?.id === id || currentPushBrowserId() === id) local = subscription ?? null;
  }
  // Stop server sends first. If local removal then fails, a persisted retry hint
  // keeps a visible recovery action without permitting further server submissions.
  try { await api.removePushBrowser(id); }
  catch (error) {
    // Another device or expired-subscription cleanup may already have removed it.
    if (!(error instanceof Error && error.message === "Browser not found")) throw error;
  }
  if (local || id === currentPushBrowserId()) localStorage.removeItem(BROWSER_ENABLED_KEY);
  if (local) {
    localStorage.setItem(BROWSER_ID_KEY, String(id));
    localStorage.setItem(REMOVE_PENDING_KEY, "1");
    try {
      if (!await local.unsubscribe()) throw new Error("unsubscribe rejected");
    } catch { throw new Error("Server alerts are disabled for this browser. Click Finish disabling this browser to retry local removal."); }
  }
  if (id === currentPushBrowserId()) {
    localStorage.removeItem(BROWSER_ID_KEY);
    localStorage.removeItem(REMOVE_PENDING_KEY);
  }
}
