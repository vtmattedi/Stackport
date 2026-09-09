import "./env";

/**
 * Central cadence table for the background Docker/nginx/Certbot status caches
 * (see src/utils/singleFlightCache.ts and its consumers). Each value is a TTL in
 * seconds — the max age of a cached value before the next request for it triggers a
 * fresh subprocess call, rather than every poll tick spawning one directly.
 *
 * Override any of these via the matching env var (seconds) without a rebuild.
 *
 * Docker/nginx/Certbot *version* checks are intentionally not listed here — they're
 * cached indefinitely after the first successful fetch and only refreshed at server
 * startup or by an explicit invalidation call (e.g. right after installing the tool
 * from the System page), never on a timer.
 *
 * `nginx -t` is likewise not a cached/polled value — it only ever runs as part of an
 * actual config validate/apply (writeNginxConfig()); routine status reads derive
 * validity from the persisted result of the last real apply instead of re-running it.
 */

function envSeconds(key: string, fallbackS: number): number {
  const raw = process.env[key];
  if (!raw) return fallbackS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackS;
}

export const pollingCadenceS = {
  //pollingCadence Version:
  version: 1,
  // Docker
  containerStats: envSeconds("POLL_CONTAINER_STATS_S", 5),       // `docker stats` — CPU/RAM
  containerState: envSeconds("POLL_CONTAINER_STATE_S", 20),      // `docker ps -a`
  dockerComposeLs: envSeconds("POLL_DOCKER_COMPOSE_LS_S", 30),   // `docker compose ls`
  dockerDiskUsage: envSeconds("POLL_DOCKER_DISK_USAGE_S", 600),  // `docker system df`
  dockerStorageCheck: envSeconds("POLL_DOCKER_STORAGE_CHECK_S", 600), // automatic build-cache cleanup check

  // Nginx
  nginxActiveStatus: envSeconds("POLL_NGINX_ACTIVE_STATUS_S", 30), // `systemctl is-active nginx`

  // Certbot
  certExistence: envSeconds("POLL_CERT_EXISTENCE_S", 60),   // per-domain cert file existence
  certExpiry: envSeconds("POLL_CERT_EXPIRY_S", 30 * 60),    // per-domain expiry/issuer (openssl)
  certRenewalCheck: envSeconds("POLL_CERT_RENEWAL_CHECK_S", 24 * 60 * 60), // container-mode auto-renew (host mode keeps using certbot.timer)
} as const;
