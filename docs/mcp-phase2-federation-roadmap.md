# Stackport: MCP Phase 2, project policies, recovery, and federation

**Status:** proposed roadmap / design discussion, November 2026. **No implementation authorized by this document.**

This proposal extends the existing single-host Stackport control plane. It reflects decisions from the owner's architecture discussion, identifies open design questions, and proposes an incremental implementation plan. It does **not** supersede completed work in [plan.md](plan.md) or the current behavior documented in [../Stackport.md](../Stackport.md).

## 1. Why

Stackport is primarily a personal infrastructure platform and an engineering learning project. It manages 10+ mixed portfolio, client-demo, live, and internal services where repeated SSH, Docker Compose commands, certificates, and provider dashboards are inconvenient. External adoption by developers with similar needs is welcome but is not the optimization target. Prefer solving observed operational problems over competing feature-for-feature with established deployment products.

A second VPS creates a useful optional use case: operate independent Stackport installations from one interface. **The immediate driver is MCP Phase 2:** giving an AI agent granular, authenticated management capabilities. A remote Stackport instance can later consume the same API. Avoid introducing cluster scheduling just to manage two VPSs.

## 2. Agreed architectural principles

1. **Full-control tokens are root-equivalent in practical effect.** This is an intentional trust boundary, not a promise of safety. Any token able to change arbitrary workloads, images, Compose definitions, mounts, or executable configuration may obtain host-level control or exfiltrate secrets, even if a separate `secret.read` permission is absent. Never advertise isolated scopes as a sandbox without validating their combined effective privileges.
2. **One management API, multiple clients.** UI, MCP, scripts, and future remote Stackport connections call a shared application/service layer with centralized authorization, validation, auditing, and operation tracking. Do not duplicate deployment logic in MCP or federation adapters.
3. **Every Stackport remains locally authoritative.** Its projects, desired state, credentials, operation history, and execution belong to that instance. Remote management is delegated access, not shared Docker state.
4. **Management relationships are directional and explicit.** A may register B, B may register C, and A may independently register C. No transitive permission inheritance, automatic full mesh, leader election, shared database, or distributed scheduler.
5. **Restricted principals must be able to recover from their own authorized mistakes.** Creating a project should normally permit bounded configuration correction, retry, and rollback for that project, subject to classification, lifecycle, and explicit scopes. Creation does not imply unrestricted deletion or access to other projects.
6. **Project risk classification and lifecycle are separate.** Classification is `structural`, `production`, or `demo`; lifecycle is proposed as `draft`, `active`, `protected`. Classification changes and promotion/demotion require explicit authorization.
7. **No silent change to existing deployments.** New policy defaults should be opt-in or apply to new projects until migration and compatibility have been assessed. Existing rollback and additive-only migration guarantees remain mandatory.

## 3. Existing capabilities to reuse and verify

Current repo docs describe:
- `/mcp` Streamable HTTP, hashed `spk_` tokens, expiry/revocation, read scope, explicit output allowlists, and token audit records. Existing tokens are intentionally not accepted on `/api`.
- A central action runner, per-project action locking, action audit/history and log streaming.
- Exact-SHA deployment revisions, effective Compose snapshots, rollback and optional health-gated automatic rollback.
- Managed environment editing, Compose policy enforcement, domain/TLS management, and the host `stackport update`/`rollback` CLI.
- An additive-only migration policy so older Stackport code can run after `stackport rollback`.

**Design implication:** MCP Phase 2 should extend the existing identity/scope and action infrastructure, not create a second token system or bypass existing project action locks. A management API used by remote instances must explicitly decide how the existing `/mcp` vs `/api` authentication separation evolves; do not simply start accepting MCP tokens on all API routes.

## 4. Proposed authorization model

Effective authorization evaluates **principal identity + capabilities + resource constraints + project classification/lifecycle + operation-specific guardrails**. A full-control token is a deliberate exception with appropriately explicit warnings and auditing.

A token identifies a stable principal (agent, operator, service, remote Stackport); rotating the token must not silently transfer or erase resource ownership. Token scopes can optionally constrain project IDs, creator/owner, name namespace, allowed domains, target instance, and expiration. Names and wildcards are convenience filters, **not** secure ownership identifiers: authorization must follow immutable project IDs and principal bindings across rename, import, and promotion.

Candidate capabilities (names are illustrative, not finalized):
- `project.read`, `project.create`, `project.configure`, `project.delete`
- `deployment.deploy`, `deployment.retry`, `deployment.rollback`, `config.restore`
- `env.keys.list`, `env.write`, `env.generate`, `secret.read`
- `domain.manage`, `certificate.manage`
- `host.maintenance`, `stackport.update`
- `project.classification.manage`, `project.lifecycle.manage`, `grant.manage`

A principal may create and manage **its own draft projects** without being allowed to edit existing production or structural projects. Operations on shared proxy settings, host ports, domains, credentials, and storage must validate cross-project ownership and collisions, not only the target project's label. Treat arbitrary Compose/image execution as a potentially privileged capability; policy must assess escalation paths rather than relying on the label `demo`.

### Project classifications (proposed defaults)

| Class | Intended use | Default posture |
| --- | --- | --- |
| `demo` | Portfolio previews, disposable tests, client demonstrations | Creator-managed creation/configuration/redeploy; constrained deletion/cleanup |
| `production` | Live client and personal services | Controlled deploy and restore; protect data, domains, secrets, destructive actions |
| `structural` | Stackport, identity, shared gateways/databases, core infrastructure | Strongest guardrails; impact may cross project boundaries |

These labels represent operational impact, not source repository type or business ownership. A demo of an identity service may still require structural safeguards if it has real credentials or shared dependencies.

### Project lifecycle (proposed)

`draft -> active -> protected`, independent of classification. A draft can be iterated on by its creator within its authorized resource boundary. Promotion can tighten rights; demotion must not be a bypass. Existing projects must receive a documented, non-disruptive migration policy.

## 5. Recovery and mistakes

**Scenario:** an agent creates a permitted demo, writes a bad environment value, deployment fails, and it needs to fix the value. A `create`-only token is insufficient; granting global `update` is unnecessary.

Proposed behavior:
1. Bind created project to stable principal and allowed resource scope.
2. Permit scoped edits, diagnostics, retries and redeploy while draft, subject to the same authorization checks.
3. Record configuration revisions (including environment metadata and recoverable secret material stored securely, never in ordinary logs).
4. Offer explicit `config.restore` and `deployment.rollback` capabilities with target-revision checks.
5. Allow short-lived, narrowly scoped grants from an already-authorized operator when recovery exceeds normal permissions. Grants must be revocable, auditable, and optionally single-use.
6. Do not promise that restoring Compose or environment state reverses database migrations, external side effects, certificate rotation, or data loss. Persistent-volume deletion and destructive cleanup require separate permissions and confirmation policies.

**Unresolved:** whether project creator rights are automatically granted as a bounded policy or independently selected at token issuance; whether protected production rollback can be preauthorized; how to handle an agent that created a project with a token later revoked; how to distinguish safe rollback from an unsafe downgrade.

## 6. MCP Phase 2: proposed tools and execution rules

Candidate tools:
- richer Stackport/host/project/action diagnostics (with explicit field allowlists and freshness)
- create/configure project from approved source and inspect effective Compose policy
- read environment **key names** separately from secret values
- write permitted environment entries, optionally batch/replace atomically
- generate cryptographically secure random values **inside Stackport**, write directly to an authorized environment target, return only metadata (never plaintext)
- deploy, retry, rollback, restore a configuration revision
- manage permitted domain routes and certificates
- request bounded cleanup and self-update through controlled operations

The server must enforce permissions regardless of client type. Every mutation must be attributable to principal/token, validate the target immediately before execution, use the existing action runner and locks, and expose operation IDs/status for retries and observation. Use idempotency keys or equivalent deduplication for non-idempotent operations. Recheck authorization on asynchronous execution; do not assume a token remains valid indefinitely after queuing.

**Security specifics:** no shell-command tool masquerading as granular permissions; no arbitrary file write; no unrestricted Compose editing under a supposedly low-privilege token; no secret values in MCP output, errors, action logs, audit trails, or previews. Environment writes should be atomic and preserve file permissions. Generated secrets are only hidden from an agent if its other privileges cannot read or exfiltrate them. Self-update is a separate highly privileged operation with health verification and a rollback/recovery path.

## 7. Optional Stackport federation

A remote instance registers another Stackport endpoint with explicit credentials and granted capabilities. Remote instance B remains the source of truth and executes requests locally; A can request operations and inspect permitted state. Connections are **directional**, can overlap, and do not imply transitive authority.

Initial scope: connect/disconnect/revoke; remote instance identity and health; list permitted projects; inspect actions/logs; request a bounded deploy or rollback; reconcile uncertain outcomes by operation ID. Remote access must be authenticated, transport-secure, and audited at the receiving instance. Prefer outbound-initiated connectivity when direct inbound exposure is undesirable, but do not commit to a relay protocol yet.

Not in scope: automatic placement, shared database, shared volumes, cluster-wide failover, distributed consensus, or scheduling across VPSs. A centralized management view is a UI convenience, not a cluster control plane. Evaluate overhead of running a full Stackport per host against lighter remote agents/SSH when fleet size grows.

## 8. Incremental implementation proposal

| Stage | Priority | Deliverable | Acceptance gate |
| --- | --- | --- | --- |
| A. Policy foundation | P1 | Principal model, capability registry, resource scoping, classification and lifecycle schema | Deny-by-default matrix; ownership/rename/promotion tests; old installs unchanged |
| B. Safe mutation API | P1 | Shared service operations, authorization checks, idempotency, audit, action integration | MCP and UI follow same policies; retry does not duplicate destructive operations |
| C. MCP Phase 2 | P1 | Scoped env writes, internal secret generation, richer diagnostics, deploy/retry | End-to-end agent-created demo can be repaired without admin token |
| D. Recovery | P2 | Config revision history, restore/rollback permissions, bounded temporary grants | Restore is verifiable; persistent data caveats surfaced; revocation works |
| E. Host maintenance | P2 | Scoped cleanup, certificate/domain operations, controlled Stackport self-update | Explicit privileges; safe failure and recovery behavior |
| F. Federation | P3 | Remote Stackport registration, scoped calls, action tracking | Two instances independently function if peer is unreachable |
| G. Federated UI | P3 | Unified remote project/health/action view | No authority confusion; no cross-instance implicit permissions |

The stages are proposals, not promised PR numbers or dates. Split them further after a source-level review. Keep the project focused on actual single-VPS operational pain before federation.

## 9. Adjacent operational backlog (separate from this design)

Previously discussed small Stackport tasks to verify against current code before opening issues:
- Hide certificate removal when the certificate is absent.
- Offer `www`/apex companion-domain handling, including correct certificate coverage and DNS checks.
- Expand disk cleanup workflows.
- Domain manager improvements.
- Investigate dangling Compose components whose names contain `x` (confirm exact intended matching behavior).
- Validate domain labels and reject invalid names, while **not** rejecting valid hyphens: `a-a.example.com` is a syntactically valid hostname. Investigate the earlier Certbot failure separately instead of treating all hyphens as invalid.

These are tracked here for planning context, not assertions that current code lacks the features.

## 10. Open questions / decisions required before implementation

1. Are token capabilities assigned per individual project ID, project class, creator, or a combination? What should the default creator-managed scope include?
2. Should a newly created project start in `draft` regardless of class, and who can promote/demote it?
3. How do we prevent privilege escalation through Compose, image execution, env references, shared volumes, proxy config, and credentials?
4. Should API clients use a common management endpoint or separate MCP/REST adapters with the same underlying authorization service?
5. Which mutations need human approval vs simply a high-privilege token?
6. What constitutes a recoverable configuration snapshot, and how are historical secrets encrypted and retained?
7. How do we handle cross-instance token revocation, identity, action idempotency, and version negotiation?
8. What is the minimum two-VPS experiment that demonstrates value without committing to distributed orchestration?

## 11. Delivery discipline

Follow existing [plan.md](plan.md) ground rules: tests with each change, additive-only database migrations compatible with `stackport rollback`, explicit existing-install upgrade behavior, and updates to [../Stackport.md](../Stackport.md) when implementation changes. This roadmap is **documentation only**; no existing deployments, APIs, or permissions are changed by it.
