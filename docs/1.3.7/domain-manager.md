# Domain manager (Stackport 1.3.7)

**Status: built (D1 to D5).** What differs from the plan below, and what is unverified:

- **The bare domain and `www`.** The plan left the bare domain out and reserved `www`. Both are handled now. A hostname can be the
  bare domain (label `@`), and `www` is an ordinary label. For the bare domain the admin chooses the canonical name: `example.com`
  with `www.example.com` redirecting to it (what nginx already did for any bare domain), or `www.example.com` with the bare domain
  redirecting to it (new: `project_domains.redirect_apex`). Either way one certificate covers both names, and the DNS check and the
  certificate gate look at both. A bare domain that another project holds cannot be claimed as the redirecting name. `www` is
  still never handed out automatically to a project that happens to be called `www`.
- **Migrations** are 018 (managed domains, label, redirect flag), 019 (per-hostname DNS result), not 015 as written here.
- **Certificate gating** applies to hostnames on a managed domain, and only when this server's address is known (detected, or entered
  on the Domains page); unmanaged hostnames behave as before.
- **Notifications** are two new push event types, `certificate_expiring` (under 14 days, once per certificate and day) and
  `certificate_renewal_failed`; they ride the renewal sweep, so they are as frequent as it is.
- **Unverified.** Everything uses an injected resolver in the tests. Not run against real DNS records, and no certificate has been
  issued for an auto-assigned hostname or for a canonical-`www` pair. The generated nginx config for both directions is tested as text, not
  loaded into a real nginx.

Decided on 7 November 2026. Today every project types its own hostnames; the certificate list is on another page and Stackport's own domain on a third. The domain manager keeps one list of **base domains Stackport manages**, and a project's hostname is always a label on one of them.

## 1. What changes for a user

- An admin adds a base domain once (`example.com`, `apps.example.com`). One of them is the **default**.
- A new project gets a hostname reserved at once: `<project-name>.<default domain>`.
- Adding or renaming a hostname means typing a label and choosing the base domain from a list. Typing a full hostname is no longer how new hostnames are made.
- One page shows every hostname with its project, route, SSL state, certificate expiry and DNS state.
- A project can still have several hostnames (the app, an API).

Out of scope for 1.3.7: wildcard certificates and DNS-01 (a later release; it needs a DNS provider integration). Certificates stay one per hostname through HTTP-01, as today.

## 2. Model

New table `managed_domains` (migration `015`):

| Column | Meaning |
|---|---|
| `id`, `name` | Base domain, lower case, unique |
| `is_default` | At most one row is `1` |
| `dns_status`, `dns_checked_at`, `dns_detail` | Result of the last DNS check |
| `created_at`, `updated_at` | |

`project_domains` gains two nullable columns: `managed_domain_id` and `label`. The stored `domain` column stays the full hostname (`label.name`), so nginx, Certbot, the health checker and the MCP read model keep working unchanged. A row with no `managed_domain_id` is **unmanaged**.

Rules:
- A label is one DNS label: letters, digits and hyphens, 1 to 63 characters, not starting or ending with a hyphen. No dots, so `a.b` is a label on `b.example.com` only if that is itself managed.
- Reserved labels: `www`, and anything that would equal Stackport's own app domain.
- A managed domain cannot be removed while any hostname uses it. Making another domain the default is one action.
- The apex (no label) is not made through the manager. An apex hostname stays an unmanaged one.

## 3. Behaviour

**Auto-assign.** When a project is created and a default exists, Stackport reserves `slug(name).<default>`. A taken label gets `-2`, `-3` and so on. It is a `project_domains` row with an empty service, which the current model already allows. SSL stays off until someone issues a certificate.

**Routing.** If the project's Compose file declares exactly one routable port, the reserved hostname is routed to it. Otherwise it stays "pick a service", because guessing between several is how traffic reaches the wrong service.

**Rename.** The new hostname is added and routed first, its certificate is issued if the old one had SSL, and only then is the old one removed. The old hostname stops working at once, with no redirect. Renaming a project never renames its hostname.

**Adoption.** On upgrade, an existing hostname with exactly one label in front of a managed domain is linked to it (longest matching base domain). Everything else stays unmanaged and keeps working. The migration changes no hostname.

**DNS check.** For a managed domain, Stackport resolves a random name under it (`sp-check-<random>.<name>`). If it resolves to this server's public address, a wildcard record exists and every new hostname works with no further DNS work. If not, each hostname is checked by itself. Results are `ok`, `not resolving`, `points elsewhere` or `unknown`. A failing check does not block adding a hostname; it blocks issuing a certificate and says why. The server's public address is a setting, filled in by detection when possible.

**Notifications.** A failed renewal or a certificate with under 14 days left sends the push notification that already exists, once per certificate and day.

**Permissions.** Only admins add, remove or default a base domain. A token limited to a project group can pick from the list for projects in its group and nothing else.

## 4. API and MCP

HTTP: `GET/POST /api/domains`, `PATCH/DELETE /api/domains/:id`, `POST /api/domains/:id/check`, plus the existing `/api/projects/:id/domains` routes taking `{ label, managedDomainId }` for new hostnames.

MCP: `list_managed_domains` (read), `set_project_hostname` (write, two-step confirmation like the network group tool, because it changes where traffic goes). Adding or removing a base domain is not exposed to MCP.

## 5. Tests

A fake resolver is injected for the DNS check, so nothing here needs a real domain. Cases: label rules and reserved labels, slug collisions, one default, refusing to remove a used domain, adoption by longest match, rename order (the old hostname is never removed before the new one is routed), certificate gating on DNS, and token scope.

## 6. Work

| ID | Item | Size |
|---|---|---|
| D1 | Table, migration `015`, adoption, API | M |
| D2 | Central Domains page and the label plus base domain picker on the project | M |
| D3 | Auto-assign at project creation, auto-route, rename flow | M |
| D4 | DNS check, public address setting, certificate gating, expiry and renewal-failure notifications | M |
| D5 | MCP tools | S |

Order: D1, then D2 and D3, then D4, then D5.

Needs a real host to verify: the DNS check against real records and a certificate issued for an auto-assigned hostname. Same blocker as the GitHub App (a public domain pointing at a test server).
