# Documentation

This directory contains **current operational guidance**, **active development plans**, and **incident records**. Historical implementation plans and superseded drafts are available in Git history and the PRs that introduced them; they are not current instructions.

## Start here

- [README](../README.md) — product overview, installation and development
- [Technical overview](../Stackport.md) — current architecture and behavior
- [Deployment preparation skill](../.agents/skills/stackport/SKILL.md) — prepare a project for Stackport

## Current plans

- [1.4 — Recovery and Stackport Control](roadmap/1.4.md)
- [1.5 — Update safety](roadmap/1.5.md)
- [Unscheduled engineering backlog](roadmap/backlog.md) — proposals only; confirm against current code before implementation

Progress and prioritization live in the [Stackport Linear project](https://linear.app/mattediworks/project/stackport-04b39996d8cf), not in separate copies of task checklists here.

## Operations

- [Operator runbook](operations/runbook.md)
- [GitHub App operations](operations/github-app.md)
- [Project network isolation](operations/network-isolation.md)
- [Live status WebSocket](operations/live-status.md)

## Engineering

- [Backend module ownership](engineering/backend-modules.md)
- [Real-host verification checklist](engineering/real-host-verification.md)
- [Staging gate](engineering/staging-gate.md)
- [Security boundaries and deferred work](engineering/security-boundaries.md)
- [Web Push reliability contract](engineering/web-push-reliability.md)
- [UI screenshots tooling](engineering/ui-screenshots.md)

## Incident history

- [1.3.0 ingress-network outage](incidents/1.3.0-network-outage.md)
- [First VPS installation](incidents/first-install.md)

## Maintenance rule

A completed feature should update the **current technical overview and relevant operating guide**, not leave its implementation plan as an active reference. Retire superseded plans after verifying no source, CI, or documentation link relies on them. Keep postmortems for their enduring safety lessons. For material changes affecting running infrastructure, follow the [staging gate](engineering/staging-gate.md).
