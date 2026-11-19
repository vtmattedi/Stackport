import { getProjectDomain, type ProjectDomain } from "../domains";
import type { RenameDeps } from "../managedDomains";
import { writeNginxConfig } from "../nginx/configWriter";
import { runCertbotAction } from "./operations";

export function projectCertificateDeps(prepareNetwork: () => Promise<void>): RenameDeps {
  return {
    applyNginx: async () => {
      await prepareNetwork();
      const result = await writeNginxConfig();
      return { ok: result.ok, message: result.output };
    },
    issueCertificate: async (domain) => {
      const cert = await runCertbotAction(domain, "issue");
      return { ok: cert.ok, message: cert.output };
    },
  };
}

/** Publish the challenge route before requesting the certificate, then reload nginx to enable HTTPS. */
export async function provisionProjectDomainTls(domain: ProjectDomain, deps: RenameDeps): Promise<{ ok: boolean; output: string }> {
  const stillWantsTls = () => getProjectDomain(domain.projectId, domain.id)?.useSsl === true;
  const cancelled = { ok: false, output: "HTTPS setup was cancelled." };
  if (!stillWantsTls()) return cancelled;
  const prepared = await deps.applyNginx();
  if (!prepared.ok) return { ok: false, output: prepared.message };
  if (!stillWantsTls()) return cancelled;
  const issued = await deps.issueCertificate(domain.domain);
  if (!issued.ok) return { ok: false, output: issued.message };
  if (!stillWantsTls()) return cancelled;
  const applied = await deps.applyNginx();
  return { ok: applied.ok, output: [issued.message, applied.message].filter(Boolean).join("\n") };
}
