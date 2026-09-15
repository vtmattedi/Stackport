import { execFile } from "child_process";
import * as path from "path";

// Reuses the already-mounted /etc/letsencrypt volume (see docker-compose.system.yml)
// rather than adding a new mount — this directory just isn't under letsencrypt/live/
// so certbot.ts's own domain-keyed cert scanning never mistakes it for a real
// Let's Encrypt certificate.
const SELF_SIGNED_DIR = "/etc/letsencrypt/stackport-selfsigned";
export const SELF_SIGNED_CERT_PATH = path.join(SELF_SIGNED_DIR, "fullchain.pem");
export const SELF_SIGNED_KEY_PATH = path.join(SELF_SIGNED_DIR, "privkey.pem");

// Small, purpose-built image (same "pull a disposable image for a one-off system
// task" pattern certbot.ts's containerAction() already uses for CERTBOT_IMAGE).
const OPENSSL_IMAGE = "alpine/openssl";

function run(cmd: string, args: string[], timeoutMs = 30_000): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: [stdout, stderr].filter(Boolean).join("\n").trim() });
    });
  });
}

/** Idempotent — generates a long-lived (10y) self-signed cert/key the very first
 *  time a domain-less (raw-IP) install boots, so the one-time bootstrap login
 *  (services/appIngress.ts) is always reachable over HTTPS even before any real
 *  domain/Let's Encrypt certificate exists. No-ops if the files already exist —
 *  never regenerates (would invalidate a browser's existing trust exception for no
 *  reason, and there's nothing here that expires meaningfully at 10 years).
 *
 *  Generation runs via an ephemeral `docker run` (the same DooD pattern
 *  certbot.ts's containerAction() uses) rather than shelling out to a local
 *  `openssl` binary — the stackport app's own /etc/letsencrypt mount is
 *  deliberately read-only (Phase 1.6: certificate issuance never happens from
 *  inside the long-lived app container, only from disposable `docker run --rm`
 *  ones), so writing the generated cert/key needs its own read-write mount. */
export async function ensureSelfSignedCert(): Promise<{ ok: boolean; output: string }> {
  const existing = await Promise.all([SELF_SIGNED_CERT_PATH, SELF_SIGNED_KEY_PATH].map((file) =>
    run("docker", ["exec", "stackport-nginx", "test", "-f", file])));
  if (existing.every((result) => result.ok)) {
    return { ok: true, output: "self-signed certificate already present" };
  }

  const script = [
    `mkdir -p ${SELF_SIGNED_DIR}`,
    `openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj /CN=stackport ` +
      `-keyout ${SELF_SIGNED_KEY_PATH} -out ${SELF_SIGNED_CERT_PATH}`,
  ].join(" && ");

  return run("docker", [
    "run", "--rm",
    "-v", "/etc/letsencrypt:/etc/letsencrypt",
    "--entrypoint", "sh",
    OPENSSL_IMAGE, "-c", script,
  ]);
}
