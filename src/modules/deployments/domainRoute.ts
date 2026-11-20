import { parseContainerPort, parseServiceName } from "../ingress/domains";
import { projectRepoDir } from "../projects/workspace";
import { getProjectIngressTargets, serviceExistsInCompose } from "./operations";

/** Phase 1.7 — confirms `service` is a real service in the project's current compose
 *  file before it's ever written to a domain row, same protection
 *  serviceExistsInCompose already gives every other single-service action. */
export async function validateDomainRoute(project: { id: number; name: string; composeFile: string | null }, service: unknown, containerPort: unknown): Promise<{ ok: true; service: string; containerPort: number } | { ok: false; error: string }> {
  const parsedService = parseServiceName(service);
  if (!parsedService) return { ok: false, error: "service must be a valid compose service name" };
  const parsedPort = parseContainerPort(containerPort);
  if (!parsedPort) return { ok: false, error: "containerPort must be a TCP port from 1 to 65535" };
  if (!project.composeFile) return { ok: false, error: "Project has no active compose file yet — pull the repository first" };

  const repoPath = projectRepoDir(project);
  const exists = await serviceExistsInCompose(repoPath, project.composeFile, parsedService);
  if (!exists) return { ok: false, error: `Service "${parsedService}" was not found in ${project.composeFile}` };
  try {
    const targets = await getProjectIngressTargets(project.id);
    if (!targets.some(target => target.service === parsedService && target.containerPort === parsedPort)) {
      return { ok: false, error: `Port ${parsedPort} is not declared for service "${parsedService}" in ${project.composeFile}` };
    }
  } catch (err) { return { ok: false, error: (err as Error).message }; }

  return { ok: true, service: parsedService, containerPort: parsedPort };
}
