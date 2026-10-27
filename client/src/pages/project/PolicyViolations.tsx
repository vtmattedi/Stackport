import { useQuery } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { api } from "../../api/client";
import styles from "./PolicyViolations.module.scss";

/** The Compose policy a deploy enforces, checked against the file in the checkout, so a
 *  violation shows as a list (service, key, fix) before the deploy fails on it. Refetched
 *  when a project action ends (the ["project", id] prefix is invalidated then). */
export function PolicyViolations({ projectId }: { projectId: number }) {
  const { data } = useQuery({
    queryKey: ["project", projectId, "compose-policy"],
    queryFn: () => api.getProjectComposePolicy(projectId),
  });
  if (!data || data.violations.length === 0) return null;

  return (
    <div className={styles.panel} role="alert">
      <div className={styles.title}>
        <ShieldAlert size={14} />
        {data.composeFile} breaks the Compose policy: deploys will be rejected
      </div>
      <table className={styles.table}>
        <thead>
          <tr><th>Service</th><th>Key</th><th>Problem</th><th>How to fix</th></tr>
        </thead>
        <tbody>
          {data.violations.map((v, i) => (
            <tr key={i}>
              <td className="mono">{v.service}</td>
              <td className="mono">{v.key}</td>
              <td>{v.problem}</td>
              <td>{v.fix}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
