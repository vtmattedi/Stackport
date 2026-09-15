import { config } from "../config/env";
import { getDatabase } from "../config/database";
import { getNginxAppConfig, getNginxRuntime, setNginxAppConfig, writeNginxConfig } from "./nginx/configWriter";
import { runCertbotAction } from "./certbot";
import { ensureSelfSignedCert } from "./nginx/selfSignedCert";
import { execFile } from "child_process";

/** Idempotent, called once at boot (src/index.ts) — makes sure StackPort's own
 *  ingress is ready before anyone can reach the login/bootstrap screen.
 *  Container-runtime only; nginx_runtime === "host" keeps today's fully manual
 *  app-domain configuration via the System page, unchanged.
 *
 *  - STACKPORT_DOMAIN set, no app domain configured yet: runs the same three-stage
 *    HTTP-then-issue-then-HTTPS flow routes/projects.ts's ssl/issue route already
 *    runs for projects (src/routes/projects.ts:688), just against the app's own
 *    domain instead of a project's.
 *  - STACKPORT_DOMAIN blank, no app domain configured: generates a self-signed
 *    cert so a raw-IP install still gets HTTPS — configWriter.ts's
 *    generateNginxConfig() picks it up automatically as the HTTPS default_server.
 *  - Successful prior bootstrap: reconcile without changing SSL settings.
 *  - Failed prior bootstrap: retry issuance on restart, preserving admin/secrets. */
export async function ensureAppIngress(): Promise<void> {
  if (getNginxRuntime() !== "container") return;
  // Compose starts both services concurrently; don't issue certificates before nginx is up.
  let nginxReady = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    nginxReady = await new Promise<boolean>((resolve) => {
      execFile("docker", ["exec", "stackport-nginx", "nginx", "-t"], { timeout: 5_000 }, (err) => resolve(!err));
    });
    if (nginxReady) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (!nginxReady) {
    console.error("[appIngress] nginx did not become ready; restart Stackport after fixing nginx");
    return;
  }
  const app = getNginxAppConfig();
  const db = getDatabase();
  const pendingKey = "nginx_app_bootstrap_pending";
  const pending = db.prepare("SELECT value FROM app_meta WHERE key = ?").get(pendingKey);
  if (app.domain && !pending) {
    // Reconcile generated config on restart without changing the operator's SSL choice.
    const apply = await writeNginxConfig();
    if (!apply.ok) console.error("[appIngress] nginx reconciliation failed:", apply.output);
    return;
  }

  if (!config.stackportDomain) {
    const selfSigned = await ensureSelfSignedCert();
    if (!selfSigned.ok) {
      // eslint-disable-next-line no-console
      console.error("[appIngress] failed to generate self-signed bootstrap certificate:", selfSigned.output);
      return;
    }
    const apply = await writeNginxConfig().catch((err: unknown) => ({ ok: false, output: err instanceof Error ? err.message : String(err) }));
    if (!apply.ok) {
      // eslint-disable-next-line no-console
      console.error("[appIngress] failed to apply nginx config for self-signed bootstrap:", apply.output);
    }
    return;
  }

  try {
    db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, '1')").run(pendingKey);
    setNginxAppConfig({ enabled: true, domain: config.stackportDomain, useSsl: false });
    const preApply = await writeNginxConfig();
    if (!preApply.ok) {
      // eslint-disable-next-line no-console
      console.error("[appIngress] HTTP route for certificate issuance failed:", preApply.output);
      return;
    }

    const cert = await runCertbotAction(config.stackportDomain, "issue");
    if (!cert.ok) {
      // eslint-disable-next-line no-console
      console.error("[appIngress] certificate issuance failed, staying on HTTP:", cert.output);
      return;
    }

    setNginxAppConfig({ enabled: true, domain: config.stackportDomain, useSsl: true });
    const sslApply = await writeNginxConfig();
    if (!sslApply.ok) {
      // eslint-disable-next-line no-console
      console.error("[appIngress] HTTPS route apply failed:", sslApply.output);
    } else {
      db.prepare("DELETE FROM app_meta WHERE key = ?").run(pendingKey);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[appIngress] failed to configure app domain:", err instanceof Error ? err.message : String(err));
  }
}
