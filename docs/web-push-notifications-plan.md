# Web Push Notifications — Implementation Plan

Durability hardening is specified in [the reliability contract](web-push-reliability.md).

**Branch:** `feat/web-push-notifications`  
**Status:** Implemented; delivery to a real device requires browser permission and a reachable push provider.
**Goal:** Add true browser push notifications to StackPort so important events can reach the operator even when the StackPort tab is closed.

Implementation decisions that supersede the suggested storage/setup below:

- Backend code now lives under `src/modules/notifications`; the `src/services` paths below are historical design references. See the [backend module map](backend-modules.md).
- All operator settings live in **Settings → Notifications**: enable/disable push, contact email or HTTPS URL, individual event preferences, browser registration/removal and test delivery.
- VAPID keys are generated automatically on first startup. The private key is encrypted with the existing host secret and stored in `push_config` in the persistent SQLite database. No environment variables or shell setup are needed. Back up the database together with `/etc/stackport/secrets.env`, which contains the encryption secret.
- Subscriptions, preferences and identity survive update, repair, restart and rollback. Migration 006 only adds tables and a defaulted log column.
- Push payloads contain concise server-created metadata and internal links, never deployment errors, environment values or updater output.
- Self-update failures are detected by a background monitor and deduplicated across application restarts.
- Automated coverage includes subscription APIs, independent email/push delivery, expired subscriptions, event preferences, browser permissions, service-worker display/click behavior and lifecycle identity preservation.

---

## 1. Current StackPort baseline

StackPort already has most of the required pieces:

- PWA support through `vite-plugin-pwa`.
- A registered service worker.
- HTTPS-first deployment.
- Authenticated Socket.IO realtime.
- Global action/realtime events.
- Existing in-app Sonner toasts.
- A Notifications settings page.
- Server-side notification handling for:
  - health-check failures;
  - blocked automatic deploys;
  - unhealthy deploys.
- Existing email delivery through Resend / MW Email Service.

Web Push should extend this notification system rather than create a parallel alert architecture.

---

## 2. Product behavior

Keep two distinct notification surfaces:

### In-app feedback

Use the existing Socket.IO + toast system for:

- builds;
- deploy progress;
- nginx changes;
- Docker operations;
- successful manual actions;
- other feedback while StackPort is open.

### Browser push

Use Web Push only for events worth interrupting the operator for while StackPort may be closed.

Initial default push events:

- project health check failed;
- automatic deploy blocked;
- deploy failed its health check;
- automatic rollback failed;
- StackPort update failed.

Future push candidates:

- certificate renewal failed;
- critical disk threshold;
- backup failed;
- restore failed;
- TCP exposure reconciliation failed.

Do not push every successful routine operation.

---

## 3. Target architecture

```text
StackPort event
      |
      v
Notification dispatcher
      |
      +-------------------+
      |                   |
      v                   v
   Email               Web Push
      |                   |
Resend / MW          Push service
                          |
                          v
                  Browser service worker
                          |
                          v
                    OS notification
```

Socket.IO remains unchanged for foreground realtime UI.

Web Push is a second delivery channel for background/offline browser delivery.

---

## 4. Notification event model

Refactor the current email-oriented notification service around a transport-neutral event.

Suggested model:

```ts
export type NotificationEventType =
  | "health_check"
  | "deploy_blocked"
  | "deploy_unhealthy"
  | "rollback_failed"
  | "system_update_failed";

export interface StackportNotification {
  type: NotificationEventType;
  severity: "info" | "warning" | "error";

  title: string;
  body: string;

  projectId?: number;
  projectName?: string;

  url?: string;
  createdAt: string;
}
```

The producer should describe the event once.

Delivery channels then decide how to render/send it.

---

## 5. Notification dispatcher

Refactor `src/services/notificationService.ts`.

Current concept:

```text
event
  ->
sendAlert()
  ->
email
```

Target:

```text
event
  ->
dispatchNotification()
      |
      +-- sendEmailNotification()
      |
      +-- sendWebPushNotification()
```

The dispatcher must:

- never make the originating deploy/health action fail because notification delivery failed;
- log each channel independently;
- allow email and push to be enabled independently;
- preserve existing email behavior.

Suggested split:

```text
src/services/notifications/
    dispatcher.ts
    emailChannel.ts
    webPushChannel.ts
    types.ts
```

The exact file split may be adjusted during implementation if keeping `notificationService.ts` smaller is preferable.

---

## 6. VAPID identity

Web Push needs a persistent application-server identity.

Store:

```text
WEB_PUSH_VAPID_PUBLIC_KEY
WEB_PUSH_VAPID_PRIVATE_KEY
```

in StackPort's persistent host secrets.

Recommended location:

```text
/etc/stackport/secrets.env
```

Rules:

- generate once;
- never regenerate during update/repair;
- private key never returned by API;
- public key may be returned to authenticated clients;
- both keys must survive backup/restore.

Extend `stackport.sh` secret generation similarly to existing persistent secrets.

If VAPID key generation requires application code/library support rather than OpenSSL shell primitives, add a small CLI/helper invoked by the installer.

---

## 7. Backend dependency

Add a maintained Node Web Push implementation, likely:

```text
web-push
```

Use it only server-side.

Responsibilities:

- configure VAPID subject/public/private keys;
- send encrypted payloads;
- interpret expired/invalid subscription responses;
- delete permanently invalid subscriptions.

Do not implement Web Push encryption manually.

---

## 8. Database model

Add persistent browser subscriptions.

Suggested table:

```sql
CREATE TABLE push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,

    user_agent TEXT,
    label TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_success_at TEXT,
    last_failure_at TEXT
);
```

StackPort is currently single-admin, so no user foreign key is required yet.

A future multi-user model can add ownership later if necessary.

Subscription endpoint/auth material should be treated as sensitive operational data even though it is not equivalent to a password.

---

## 9. Push API

Add authenticated endpoints:

```text
GET    /api/notifications/push/config
GET    /api/notifications/push/subscriptions
POST   /api/notifications/push/subscriptions
DELETE /api/notifications/push/subscriptions/:id
POST   /api/notifications/push/test
```

### GET config

Return only safe client data:

```json
{
  "supported": true,
  "vapidPublicKey": "...",
  "enabled": true
}
```

Never return the VAPID private key.

### POST subscription

Accept the browser PushSubscription:

```json
{
  "endpoint": "...",
  "keys": {
    "p256dh": "...",
    "auth": "..."
  },
  "label": "Chrome on Windows"
}
```

Use upsert semantics by endpoint.

### DELETE subscription

Remove one registered browser.

### POST test

Send a test push to the current/all registered subscriptions, depending on final UX.

Return useful per-subscription failure information without exposing secrets.

---

## 10. Invalid subscription cleanup

Web Push endpoints expire.

When push delivery returns a permanent invalidation such as HTTP 404/410:

```text
delete subscription
```

For temporary failures:

```text
retain subscription
record failure
log warning
```

Do not repeatedly retry dead subscriptions forever.

---

## 11. PWA/service-worker change

Current StackPort uses generated Workbox service-worker behavior.

For push handling, move to a custom service worker using `vite-plugin-pwa` `injectManifest` mode.

Suggested:

```text
client/src/sw.ts
```

It should include:

- Workbox precache injection;
- push event handling;
- notification click handling;
- existing cache cleanup/update behavior.

Conceptual push handler:

```ts
self.addEventListener("push", (event) => {
  const payload = event.data?.json();

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/pwa-192x192.png",
      badge: "/pwa-192x192.png",
      tag: payload.tag,
      data: {
        url: payload.url,
      },
    }),
  );
});
```

Do not rely on an open page to show the notification.

---

## 12. Notification click behavior

Clicking a StackPort notification should navigate to the most relevant page.

Examples:

```text
health failure
    -> /projects/<id>

deploy unhealthy
    -> /projects/<id>/deployments

system update failure
    -> /settings/general
```

The service worker should:

1. close the notification;
2. inspect existing StackPort window clients;
3. focus an existing client when possible;
4. navigate it to the notification URL;
5. otherwise open a new StackPort window.

All URLs must be local StackPort paths supplied by trusted server-side event construction.

Do not accept arbitrary external notification URLs from clients.

---

## 13. Frontend push helper

Add a browser-side helper such as:

```text
client/src/lib/pushNotifications.ts
```

Responsibilities:

- detect support:
  - service workers;
  - Push API;
  - Notifications API;
- expose current permission state;
- request notification permission only from a user gesture;
- obtain the active service-worker registration;
- subscribe using the VAPID public key;
- send subscription to StackPort API;
- unsubscribe locally and remove server registration.

Do not request permission automatically on login/page load.

---

## 14. Settings UI

Extend:

```text
Settings -> Notifications
```

Keep existing Email section and add:

```text
Browser push
────────────────────────────────

Status:
  Supported
  Permission: Granted
  This browser: Enabled

[ Enable on this browser ]
[ Send test ]
[ Disable this browser ]
```

Below that, show registered browser subscriptions:

```text
Chrome · Windows
This browser
Last successful push: 2 min ago
[ Remove ]

Chrome · Android
Last successful push: yesterday
[ Remove ]
```

Because StackPort is single-admin, all registered devices belong to the same operator.

Update the Settings navigation description from email-only wording to general notification wording.

---

## 15. Permission states

UI must distinguish:

```text
unsupported
default / not requested
granted
denied
```

If denied:

- explain that the browser/site permission must be changed manually;
- do not repeatedly call `Notification.requestPermission()`.

If unsupported:

- disable browser-push controls;
- leave email controls usable.

---

## 16. Foreground duplicate behavior

V1 may allow both:

```text
in-app toast
+
OS push notification
```

for critical failures even if StackPort is open.

This is acceptable initially and keeps implementation deterministic.

Optional later improvement:

- suppress Web Push to a subscription while that browser has a visible authenticated Socket.IO session.

Do not block initial implementation on presence tracking.

---

## 17. Notification preferences

Initial implementation can use one global Browser Push toggle plus a fixed event policy.

Recommended V1 event defaults:

```text
health_check          push ON
deploy_blocked        push ON
deploy_unhealthy      push ON
rollback_failed       push ON
system_update_failed  push ON
```

Email behavior remains independently configurable.

A later version may add per-event preferences:

```text
Event                       Email    Push
Health failed               [x]      [x]
Deploy blocked              [x]      [x]
Deploy unhealthy            [x]      [x]
Successful deploy           [ ]      [ ]
Disk critical               [x]      [x]
```

Do not overbuild this in V1.

---

## 18. Notification logs

Current `notification_logs` is email-oriented.

Either generalize it or add channel information.

Preferred migration:

```sql
ALTER TABLE notification_logs
ADD COLUMN channel TEXT NOT NULL DEFAULT 'email';
```

Possible values:

```text
email
web_push
```

For push entries, `recipient` may contain a safe subscription label or opaque local identifier rather than the full endpoint.

Never render the entire push endpoint/auth material in logs/UI.

The Notifications settings page can then show one unified recent-delivery log.

---

## 19. Event integration

Refactor current producers to emit one notification event into the dispatcher.

Existing producers include:

- `healthChecker.ts`;
- deploy health validation in `projectDeploy.ts`;
- auto-deploy blocked paths.

Add push-worthy events where not currently represented:

- rollback failure;
- system self-update failure.

Do not couple producers directly to `web-push`.

---

## 20. Security requirements

- All push subscription APIs require authenticated admin access.
- VAPID private key remains host-secret only.
- Subscription auth values are never exposed in list endpoints.
- Subscription endpoints are never logged in full.
- Push payloads must contain no credentials, environment values, API keys, logs, or other secrets.
- Payload content should be concise operational metadata only.
- Notification click URLs are internal trusted paths.
- Existing auth/session behavior remains unchanged.

A push notification is a signal to open StackPort, not a transport for sensitive diagnostic data.

---

## 21. Backup/restore compatibility

Full StackPort backup must include:

```text
VAPID public/private keys
push_subscriptions rows
notification preferences
notification logs if logs are in backup scope
```

Restoring the same VAPID identity is important.

However, browser push subscriptions may not remain valid forever after a long migration/restore. Restore them, attempt delivery normally, and clean up invalid subscriptions based on push-service responses.

Do not regenerate VAPID keys during restore unless explicitly creating a new notification identity.

---

## 22. Installer/update behavior

### Fresh install

Generate persistent VAPID identity once.

### Existing installs

On update to the Web Push version:

```text
if VAPID keys missing:
    generate once
else:
    preserve
```

This migration must be idempotent.

`stackport repair` must preserve keys.

`stackport uninstall` without `--purge` preserves them.

`stackport uninstall --purge` removes them with the rest of StackPort secret state.

---

## 23. PWA update regression risk

Changing from generated service worker to `injectManifest` must preserve current PWA behavior:

- auto-update;
- cache version cleanup;
- latest release activation;
- controlled-client refresh behavior;
- PWA installability.

The existing `client/src/pwa.ts` version polling should continue to trigger service-worker update checks.

Do not regress StackPort's current release-update behavior while adding push handling.

---

## 24. Tests

### Backend unit/integration

```text
PASS: VAPID public key endpoint never exposes private key
PASS: subscription create/upsert
PASS: subscription list redacts p256dh/auth/endpoint as appropriate
PASS: subscription delete
PASS: invalid subscription payload rejected
PASS: push channel receives dispatcher event
PASS: email delivery continues independently
PASS: 404/410 push response deletes dead subscription
PASS: temporary push failure retains subscription
PASS: failed push never fails deploy/health workflow
```

### Notification event policy

```text
PASS: health failure emits push-worthy event
PASS: deploy blocked emits push-worthy event
PASS: unhealthy deploy emits push-worthy event
PASS: routine successful build does not push
```

### Frontend

```text
PASS: unsupported browser shown correctly
PASS: permission default state
PASS: denied permission state
PASS: subscribe flow posts browser subscription
PASS: unsubscribe removes local + server subscription
PASS: test push control
```

### Service worker

```text
PASS: push event displays notification
PASS: title/body rendered
PASS: click focuses existing StackPort window
PASS: click opens StackPort if no client exists
PASS: click navigates to intended internal route
```

### Regression

```text
PASS: PWA remains installable
PASS: service worker still auto-updates
PASS: normal Socket.IO toasts still work
PASS: email notifications still work
PASS: clean install
PASS: update from pre-push StackPort install
PASS: repair preserves VAPID identity
```

---

## 25. Validation gate

Run:

```bash
npm run lint
npm run typecheck
npm run build:dry
npm --prefix client run lint
bash -n stackport.sh
```

Then run the existing clean-install regression:

```powershell
powershell -File scripts/test-clean-install.ps1
```

Add VAPID-generation/persistence checks to the install/update regression where practical.

Browser Push itself may need a separate browser-driven integration test because a headless clean-install shell cannot fully emulate browser permission/push-service behavior.

---

## 26. Suggested implementation order

```text
1. Add persistent VAPID secrets.
2. Add web-push backend dependency.
3. Add push_subscriptions schema/service.
4. Add authenticated push API.
5. Refactor notificationService into dispatcher + channels.
6. Route existing alert events through dispatcher.
7. Add Web Push channel.
8. Switch PWA to custom injectManifest service worker.
9. Implement push + notificationclick handlers.
10. Add browser subscription helper.
11. Add Browser Push settings UI.
12. Generalize notification delivery logs with channel.
13. Add rollback/system-update push events.
14. Add tests.
15. Update Stackport.md.
```

---

## 27. Definition of done

Web Push is complete when:

> An authenticated StackPort operator can enable browser push for a browser from Settings, close StackPort, and later receive an OS-level notification for a critical StackPort event such as a project health failure or unhealthy deploy. Clicking the notification opens or focuses StackPort at the relevant page. Existing email notifications, PWA auto-update behavior, realtime Socket.IO toasts, and StackPort lifecycle/update behavior continue to work unchanged.
