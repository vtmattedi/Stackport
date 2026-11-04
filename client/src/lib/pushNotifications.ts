import { api } from "../api/client";
import type { PushBrowser } from "../api/types";

const BROWSER_ID_KEY = "stackport_push_browser_id";

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

/** Called directly from a click: the permission prompt precedes any async fetch. */
export async function enableBrowserPush(publicKey: string, label: string): Promise<PushBrowser> {
  if (!supportsBrowserPush()) throw new Error("Browser push is not supported here. Use HTTPS and a browser with Web Push support.");
  if (Notification.permission === "denied") throw new Error("Notifications are blocked. Allow them in your browser's site settings, then try again.");
  const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notification permission was not granted.");
  const registration = await worker();
  const raw = atob(publicKey.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - publicKey.length % 4) % 4));
  const applicationServerKey = Uint8Array.from(raw, (character) => character.charCodeAt(0));
  let subscription = await registration.pushManager.getSubscription();
  // A restored installation can have a different identity; replace stale local keys.
  const previousKey = subscription?.options.applicationServerKey;
  if (subscription && previousKey && !new Uint8Array(previousKey).every((byte, index) => byte === applicationServerKey[index])) {
    await subscription.unsubscribe();
    subscription = null;
  }
  const created = !subscription;
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
  try {
    const browser = await api.savePushBrowser({ ...subscription.toJSON(), label: label.trim() || "Browser" });
    localStorage.setItem(BROWSER_ID_KEY, String(browser.id));
    return browser;
  } catch (error) {
    if (created) await subscription.unsubscribe().catch(() => undefined);
    throw error;
  }
}

export async function disableBrowserPush(id: number): Promise<void> {
  if (id === currentPushBrowserId() && supportsBrowserPush()) {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription && !await subscription.unsubscribe()) throw new Error("Could not unsubscribe this browser. Try again.");
  }
  try { await api.removePushBrowser(id); }
  catch (error) {
    // Another device or expired-subscription cleanup may already have removed it.
    if (!(error instanceof Error && error.message === "Browser not found")) throw error;
  }
  if (id === currentPushBrowserId()) localStorage.removeItem(BROWSER_ID_KEY);
}
