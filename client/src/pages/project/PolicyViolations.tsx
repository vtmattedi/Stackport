import { useQuery } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { api } from "../../api/client";
import type { PolicyViolation } from "../../api/types";
import styles from "./PolicyViolations.module.scss";

function ViolationTable({ violations }: { violations: PolicyViolation[] }) {
  return (
    <table className={styles.table}>
      <thead>
        <tr><th>Service</th><th>Key</th><th>Problem</th><th>How to fix</th></tr>
      </thead>
      <tbody>
        {violations.map((v, i) => (
          <tr key={i}>
            <td className="mono">{v.service}</td>
            <td className="mono">{v.key}</td>
            <td>{v.problem}</td>
            <td>{v.fix}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The Compose policy a deploy enforces, checked against the file in the checkout, so a
 *  violation shows as a list (service, key, fix) before the deploy fails on it. The file is
 *  checked as written (every project) and as Compose resolves it (rejected for a project that
 *  enforces the policy, a warning for one that does not). Refetched when a project action
 *  ends (the ["project", id] prefix is invalidated then). */
export function PolicyViolations({ projectId }: { projectId: number }) {
  const { data } = useQuery({
    queryKey: ["project", projectId, "compose-policy"],
    queryFn: () => api.getProjectComposePolicy(projectId),
  });
  if (!data || !data.composeFile) return null;

  const raw = data.violations;
  const { checked, reason, violations: resolved } = data.resolved;
  const unresolved = !checked;
  if (raw.length === 0 && resolved.length === 0 && !unresolved) return null;

  return (
    <>
      {raw.length > 0 && (
        <div className={styles.panel} role="alert">
          <div className={styles.title}>
            <ShieldAlert size={14} />
            {data.composeFile} breaks the Compose policy: deploys will be rejected
          </div>
          <ViolationTable violations={raw} />
        </div>
      )}
      {resolved.length > 0 && (
        <div className={data.enforced ? styles.panel : `${styles.panel} ${styles.warn}`} role="alert">
          <div className={styles.title}>
            <ShieldAlert size={14} />
            {data.enforced
              ? `${data.composeFile} breaks the policy once Compose resolves it: deploys will be rejected`
              : `${data.composeFile} breaks the policy once Compose resolves it: this project only gets a warning, a new one would be rejected`}
          </div>
          <ViolationTable violations={resolved} />
        </div>
      )}
      {unresolved && (
        <div className={`${styles.panel} ${styles.warn}`} role="status">
          <div className={styles.title}>
            <ShieldAlert size={14} />
            {data.enforced
              ? `${data.composeFile} could not be resolved, so it cannot be checked: deploys will be refused`
              : `${data.composeFile} could not be resolved, so the resolved checks were skipped`}
          </div>
          {reason && <div className="mono">{reason}</div>}
        </div>
      )}
    </>
  );
}
