import { config } from "../config/env";
import { getNginxAppConfig, getNginxRuntime, setNginxAppConfig, writeNginxConfig } from "./nginx/configWriter";
import { runCertbotAction } from "./certbot";
import { ensureSelfSignedCert } from "./nginx/selfSignedCert";

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
 *  - App domain already configured (either path, on a prior boot): no-op. */
export async function ensureAppIngress(): Promise<void> {
  if (getNginxRuntime() !== "container") return;
  if (getNginxAppConfig().domain) return;

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
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[appIngress] failed to configure app domain:", err instanceof Error ? err.message : String(err));
  }
}
