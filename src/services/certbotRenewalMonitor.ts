import { execFile } from "child_process";
import { pollingCadenceS } from "../config/pollingCadence";
import { auditLog } from "../utils/logger";
import { getNginxRuntime, CERTBOT_WEBROOT_PATH } from "./nginx/configWriter";
import { invalidateCertCaches } from "./certbot";

/** Phase 1.6 — once cut over to containerized certbot, the host's own `certbot.timer`
 *  (which drove renewal before) is no longer in the picture, so something needs to
 *  replace it. `certbot renew` is a single system-wide sweep (it scans every cert
 *  under /etc/letsencrypt/renewal/ itself and renews whichever are due) — no
 *  per-domain looping needed, matching exactly what certbot.timer already did. No-ops
 *  entirely while nginx_runtime stays "host" (the default) — certbot.timer keeps
 *  owning renewal in that mode, unchanged. */
class CertbotRenewalMonitor {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.check(), pollingCadenceS.certRenewalCheck * 1000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async check(): Promise<void> {
    if (this.running || getNginxRuntime() !== "container") return;
    this.running = true;
    try {
      const result = await new Promise<{ ok: boolean; output: string }>((resolve) => {
        execFile("docker", [
          "run", "--rm",
          "-v", "/etc/letsencrypt:/etc/letsencrypt",
          "-v", `${CERTBOT_WEBROOT_PATH}:/var/www/certbot`,
          "certbot/certbot",
          "renew", "--webroot", "-w", "/var/www/certbot", "--non-interactive",
        ], { timeout: 600_000 }, (err, stdout, stderr) => {
          resolve({ ok: !err, output: [stdout, stderr].filter(Boolean).join("\n").trim() });
        });
      });
      invalidateCertCaches();
      auditLog("system", "system.certbot-auto-renew", "certbot", result.ok ? "ok" : "fail", { output: result.output.slice(0, 2000) });
    } catch {
      // best-effort background maintenance — a failed check just tries again next tick
    } finally {
      this.running = false;
    }
  }
}

export const certbotRenewalMonitor = new CertbotRenewalMonitor();
