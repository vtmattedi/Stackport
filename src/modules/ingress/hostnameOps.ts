import { ensureProjectProxyNetwork } from "../deployments/operations";
import { runCertbotAction } from "./certificates/operations";
import { renameProjectHostname, type RenameDeps } from "./managedDomains";
import { writeNginxConfig } from "./nginx/configWriter";

/** The real dependencies of a hostname change: nginx applied from the current rows, and a certificate if the old one had SSL.
 *  Shared by the HTTP route and the MCP tool so the two cannot drift. */
export function realRenameDeps(projectId: number): RenameDeps {
  return {
    applyNginx: async () => {
      await ensureProjectProxyNetwork(projectId);
      const result = await writeNginxConfig();
      return { ok: result.ok, message: result.output ?? "" };
    },
    issueCertificate: async (domain) => {
      const cert = await runCertbotAction(domain, "issue");
      return { ok: cert.ok, message: cert.output };
    },
  };
}

export { renameProjectHostname };
