import { config } from "../config/env";
import { getDatabase } from "../config/database";
import { getNginxAppConfig, setNginxAppConfig, writeNginxConfig } from "./nginx/configWriter";
import { runCertbotAction } from "./certbot";
import { ensureSelfSignedCert } from "./nginx/selfSignedCert";
import { execFile } from "child_process";

/** Reconcile the admin route at boot, then bootstrap certificates when needed. */
export async function ensureAppIngress(): Promise<void> {
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
