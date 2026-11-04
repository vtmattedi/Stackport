/// <reference lib="webworker" />
import { clientsClaim, setCacheNameDetails } from "workbox-core";
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: { url: string; revision?: string | null }[] };
declare const __APP_VERSION__: string;

setCacheNameDetails({ prefix: "stackport-client", suffix: __APP_VERSION__ });
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
registerRoute(new NavigationRoute(createHandlerBoundToURL("/index.html"), {
  denylist: [/^\/api(?:\/|$)/, /^\/mcp(?:\/|$)/, /^\/health(?:\/|$)/],
}));
void self.skipWaiting();
clientsClaim();

function internalUrl(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const url = new URL(value, self.location.origin);
    return url.origin === self.location.origin ? `${url.pathname}${url.search}${url.hash}` : "/";
  } catch { return "/"; }
}

self.addEventListener("push", (event) => {
  let payload: Record<string, unknown> = {};
  try {
    const data: unknown = event.data?.json();
    if (data && typeof data === "object") payload = data as Record<string, unknown>;
  } catch { /* Still show a generic notification for a malformed/empty message. */ }
  event.waitUntil(self.registration.showNotification(
    typeof payload["title"] === "string" ? payload["title"].slice(0, 160) : "Stackport alert",
    { body: typeof payload["body"] === "string" ? payload["body"].slice(0, 500) : "Open Stackport for details.",
      icon: "/pwa-192x192.png", badge: "/pwa-192x192.png",
      tag: typeof payload["tag"] === "string" ? payload["tag"] : undefined,
      data: { url: internalUrl(payload["url"]) } },
  ));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = internalUrl((event.notification.data as { url?: unknown } | undefined)?.url);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      try {
        const navigated = await client.navigate(url);
        await (navigated ?? client).focus();
        return;
      } catch { /* Try another window, or open one below. */ }
    }
    await self.clients.openWindow(url);
  })());
});
