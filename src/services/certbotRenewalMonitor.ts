import { execFile } from "child_process";
import { pollingCadenceS } from "../config/pollingCadence";
import { auditLog } from "../utils/logger";
import { reloadNginx, CERTBOT_WEBROOT_PATH } from "./nginx/configWriter";
import { invalidateCertCaches } from "./certbot";

/** Periodically renew all due certificates in a temporary Certbot container. */
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
    if (this.running) return;
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
      if (result.ok) {
        const reload = await reloadNginx();
        if (!reload.ok) auditLog("system", "system.certbot-auto-renew-reload", "nginx", "fail", {output: reload.output.slice(0, 2000)});
      }
      auditLog("system", "system.certbot-auto-renew", "certbot", result.ok ? "ok" : "fail", { output: result.output.slice(0, 2000) });
    } catch {
      // best-effort background maintenance — a failed check just tries again next tick
    } finally {
      this.running = false;
    }
  }
}

export const certbotRenewalMonitor = new CertbotRenewalMonitor();
