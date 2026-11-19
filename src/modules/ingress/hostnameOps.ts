import { announceBranchPreview } from "../github/branchPreview";
import { ensureProjectProxyNetwork } from "../deployments/operations";
import { projectCertificateDeps, provisionProjectDomainTls } from "./certificates/project";
import { renameProjectHostname, type RenameDeps } from "./managedDomains";
import { actionRegistry, projectSslKey } from "../actions/registry";
import type { ProjectDomain } from "./domains";
import { auditLog } from "../../shared/logger";

/** The real dependencies of a hostname change: nginx applied from the current rows, with certificate issuance for HTTPS.
 *  Shared by the HTTP route and the MCP tool so the two cannot drift. */
export function realRenameDeps(projectId: number): RenameDeps {
  return projectCertificateDeps(() => ensureProjectProxyNetwork(projectId));
}

export { renameProjectHostname };

export function startProjectDomainTls(domain: ProjectDomain, actor: string): ReturnType<typeof actionRegistry.tryStart> {
  const { projectId, id: domainId } = domain;
  return actionRegistry.tryStart(projectSslKey(projectId, domainId), "ssl-issue", { projectId, domainId, domain: domain.domain }, async () => {
    const result = await provisionProjectDomainTls(domain, realRenameDeps(projectId));
    auditLog(actor, "project.ssl-issue", domain.domain, result.ok ? "ok" : "fail");
    const preview = result.ok ? await announceBranchPreview(projectId) : "";
    return { ...result, output: [result.output, preview].filter(Boolean).join("\n") };
  });
}
