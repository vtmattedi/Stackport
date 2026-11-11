import { ensureProjectProxyNetwork } from "../deployments/operations";
import { runCertbotAction } from "./certificates/operations";
import { dnsGate } from "./dnsCheck";
import { renameProjectHostname, type RenameDeps } from "./managedDomains";
import { writeNginxConfig } from "./nginx/configWriter";

/** The real dependencies of a hostname change: nginx applied from the current rows, a certificate only after DNS resolves.
 *  Shared by the HTTP route and the MCP tool so the two cannot drift. */
export function realRenameDeps(projectId: number): RenameDeps {
  return {
    applyNginx: async () => {
      await ensureProjectProxyNetwork(projectId);
      const result = await writeNginxConfig();
      return { ok: result.ok, message: result.output ?? "" };
    },
    issueCertificate: async (domain) => {
      const gate = await dnsGate(domain);
      if (!gate.ok) return { ok: false, message: gate.reason ?? "DNS does not point here yet." };
      const cert = await runCertbotAction(domain, "issue");
      return { ok: cert.ok, message: cert.output };
    },
  };
}

export { renameProjectHostname };
