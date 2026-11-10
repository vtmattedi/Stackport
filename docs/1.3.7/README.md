# Stackport 1.3.7 (plan)

Not started. 1.3.7 holds two features: the GitHub App and the domain manager. Release order: **1.3.1** (done) → **1.3.5** → **1.3.7** → **1.4**. There is no 1.3.6.

The **GitHub App** was moved out of 1.3.5 on 7 November 2026 so that 1.3.5 can ship the fixes that follow the 1.3.0 incident ([../1.3.5/postmortem-1.3.0-ingress-networks.md](../1.3.5/postmortem-1.3.0-ingress-networks.md)) without waiting for a feature that needs a real GitHub account and a real HTTPS host to test.

Plan: [github-app.md](github-app.md). Security reference it builds on: [../1.3/github-app.md](../1.3/github-app.md).

## Already done

| ID | Item | Where |
|---|---|---|
| G1 | The Git token is out of process arguments (environment-scoped to the origin; a PAT stays an explicit mode, no silent fallback). The App plan relies on it. | 1.3.5 branch, [../1.3/security.md](../1.3/security.md) |

## To build

Phases A to D from the plan: registration through the App Manifest flow, secrets with the keyring, installation tokens and linking, repository discovery; the Git credential resolver and the App source in the new-project wizard, with PAT to App migration; the signed webhook receiver with a durable delivery table; hardening and rollback tests. The modules chosen so far are M1 (report deploys to GitHub), M2 (deploy only after CI passes) and M3 (deploy on release); the owner of the App is chosen at registration.

Working On It: GitHub App #368 to #371; domain manager #389 to #393.

## Domain manager

A central list of base domains Stackport manages. Projects get a hostname on the default one automatically, and adding or renaming a hostname means choosing a label and a managed domain. Wildcard certificates (DNS-01) are not part of 1.3.7. Plan: [domain-manager.md](domain-manager.md).

## Before starting

- Have the staging host ready: the manifest flow needs a public HTTPS domain, and webhooks need to reach it.
