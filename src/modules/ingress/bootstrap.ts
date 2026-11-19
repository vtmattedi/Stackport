import { config } from "../../config/env";
import { getDatabase } from "../../config/database";
import { getNginxAppConfig, setNginxAppConfig, writeNginxConfig } from "./nginx/configWriter";
import { getCertbotStatus, runCertbotAction } from "./certificates/operations";
import { ensureSelfSignedCert } from "./nginx/selfSignedCert";
import { execFile } from "child_process";
import { logger } from "../../shared/logger";

export const appIngressDeps = {
  nginxReady: (): Promise<boolean> => new Promise((resolve) => {
    execFile("docker", ["exec", "stackport-nginx", "nginx", "-t"], { timeout: 5_000 }, (err) => resolve(!err));
  }),
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
  apply: (): Promise<{ ok: boolean; output: string }> => writeNginxConfig(),
  hasCertificate: async (domain: string): Promise<boolean> =>
    (await getCertbotStatus()).entries.some((entry) => entry.domain === domain && entry.hasCertificate),
  issue: (domain: string): Promise<{ ok: boolean; output: string }> => runCertbotAction(domain, "issue"),
  selfSigned: ensureSelfSignedCert,
};

/** Reconcile the admin route at boot, then bootstrap certificates when needed. */
export async function ensureAppIngress(): Promise<void> {
  // Compose starts both services concurrently; don't issue certificates before nginx is up.
  let nginxReady = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    nginxReady = await appIngressDeps.nginxReady();
    if (nginxReady) break;
    await appIngressDeps.sleep(1_000);
  }
  if (!nginxReady) {
    logger.error("appIngress: nginx did not become ready; restart Stackport after fixing nginx");
    return;
  }
  const app = getNginxAppConfig();
  const db = getDatabase();
  const pendingKey = "nginx_app_bootstrap_pending";
  const pending = db.prepare("SELECT value FROM app_meta WHERE key = ?").get(pendingKey);
  if (app.domain && !pending) {
    try {
      // With no certificate, this renders HTTP plus ACME's challenge location.
      // Use the saved address and preserve an explicit HTTP-only choice.
      const apply = await appIngressDeps.apply();
      if (!apply.ok) {
        logger.error({ output: apply.output }, "appIngress: nginx reconciliation failed");
        return;
      }
      if (!app.enabled || !app.useSsl || await appIngressDeps.hasCertificate(app.domain)) return;

      logger.info({ domain: app.domain }, "appIngress: requesting the missing certificate for the saved hostname");
      const cert = await appIngressDeps.issue(app.domain);
      if (!cert.ok) {
        logger.error({ domain: app.domain, output: cert.output }, "appIngress: certificate issuance failed, staying on HTTP");
        return;
      }
      const sslApply = await appIngressDeps.apply();
      if (!sslApply.ok) logger.error({ domain: app.domain, output: sslApply.output }, "appIngress: certificate issued but HTTPS apply failed");
    } catch (error) {
      logger.error({ domain: app.domain, error: error instanceof Error ? error.message : String(error) }, "appIngress: saved hostname reconciliation failed");
    }
    return;
  }

  if (!config.stackportDomain) {
    const selfSigned = await appIngressDeps.selfSigned();
    if (!selfSigned.ok) {
      // eslint-disable-next-line no-console
      console.error("[appIngress] failed to generate self-signed bootstrap certificate:", selfSigned.output);
      return;
    }
    const apply = await appIngressDeps.apply().catch((err: unknown) => ({ ok: false, output: err instanceof Error ? err.message : String(err) }));
    if (!apply.ok) {
      // eslint-disable-next-line no-console
      console.error("[appIngress] failed to apply nginx config for self-signed bootstrap:", apply.output);
    }
    return;
  }

  try {
    db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, '1')").run(pendingKey);
    setNginxAppConfig({ enabled: true, domain: config.stackportDomain, useSsl: false });
    const preApply = await appIngressDeps.apply();
    if (!preApply.ok) {
      // eslint-disable-next-line no-console
      console.error("[appIngress] HTTP route for certificate issuance failed:", preApply.output);
      return;
    }

    const cert = await appIngressDeps.issue(config.stackportDomain);
    if (!cert.ok) {
      // eslint-disable-next-line no-console
      console.error("[appIngress] certificate issuance failed, staying on HTTP:", cert.output);
      return;
    }

    setNginxAppConfig({ enabled: true, domain: config.stackportDomain, useSsl: true });
    const sslApply = await appIngressDeps.apply();
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
