/**
 * What each backup level may contain, decided table by table. Default-deny: a table that is
 * not listed here is emptied in every archive and named in the manifest, so a new table can
 * never leak into a lower level by omission (tests/backup.test.ts fails until it is classified).
 */

export type BackupLevel = 1 | 2;

/** `l1`: instance-wide configuration. `l2`: project records. `never`: runtime state, logs, history, sessions, caches. */
export type TableTier = "l1" | "l2" | "never";

export const TABLE_TIERS: Record<string, TableTier> = {
  // Level 1 — instance settings, identity, credentials and integrations.
  app_meta: "l1", // filtered by META_KEYS below
  credentials: "l1",
  webhooks: "l1",
  vps_providers: "l1",
  vps_monitored_vms: "l1",
  firewall_profiles: "l1",
  firewall_rules: "l1",
  notification_config: "l1",
  github_poller_config: "l1",
  github_app: "l1",
  github_app_installations: "l1",
  github_app_repositories: "l1",
  push_config: "l1",
  api_tokens: "l1", // hashes only; a clone drops them
  managed_domains: "l1",
  peer_targets: "l1", // a clone drops these: pairings never carry over to a copy
  peer_controllers: "l1",

  // Level 2 — everything that describes a project.
  projects: "l2",
  project_env_files: "l2",
  project_domains: "l2",
  tcp_exposures: "l2",
  project_deployments: "l2",
  network_group_services: "l2",
  legacy_mount_sources: "l2",

  // Never — sessions and one-time credentials, queues, caches, samples, logs and delivery history.
  auth_tokens: "never",
  setup_credentials: "never",
  actions: "never",
  push_subscriptions: "never",
  push_deliveries: "never",
  push_events: "never",
  github_app_deliveries: "never",
  github_app_states: "never",
  hook_deliveries: "never",
  project_deploys: "never",
  project_resource_samples: "never",
  project_folder_size_samples: "never",
  hardware_samples: "never",
  notification_logs: "never",
  vps_vm_cache: "never",
  peer_pairing_codes: "never",
  peer_nonces: "never",
};

/** The `app_meta` rows an archive keeps. Everything else (heartbeats, pending flags, last-outcome notes) is runtime state. */
export const META_KEYS: readonly string[] = [
  "instance_id",
  "instance_name",
  "installation_initialized",
  "admin_username",
  "admin_password_hash",
  "certbot_email",
  "nginx_app_domain",
  "nginx_app_enabled",
  "nginx_app_use_ssl",
  "docker_storage_warning_free_bytes",
  "docker_storage_warning_free_pct",
  "docker_storage_critical_free_bytes",
  "docker_storage_critical_free_pct",
  "hardening_memory_mb",
  "hardening_pids_limit",
  "status_stream_enabled",
  "status_stream_instance",
  "app_update_credential_id",
  "project_domains_seeded_from_legacy",
];

export function tierIncluded(tier: TableTier | undefined, level: BackupLevel): boolean {
  if (tier === "l1") return true;
  if (tier === "l2") return level >= 2;
  return false;
}

/** The host values a backup records so a restore can show what differs, but never applies by itself. */
export const HOST_ENV_KEYS: readonly string[] = ["STACKPORT_DOMAIN", "CERTBOT_EMAIL", "ALLOWED_ORIGINS", "STACKPORT_ISOLATION_RANGE"];

/** The keys the stored ciphertext and sessions depend on. They travel inside the encrypted archive, never beside it. */
export const SECRET_ENV_KEYS: readonly string[] = ["JWT_SECRET", "ENCRYPTION_KEY", "ENCRYPTION_KEY_PREVIOUS", "WEBHOOK_SECRET"];
