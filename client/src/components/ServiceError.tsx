import { AlertCircle } from "lucide-react";
import { Alert, AlertDescription } from "./ui/alert";
import styles from "./ServiceError.module.scss";

interface Explanation {
  summary: string;
  fix: string | null;
}

/** Turns a raw service error (Docker CLI output, exec errors) into a plain sentence and a next step. */
export function explainServiceError(service: string, reason: string | null | undefined): Explanation {
  const raw = (reason ?? "").toLowerCase();
  if (raw.includes("permission denied") && raw.includes("docker")) {
    return {
      summary: "Stackport doesn't have permission to use Docker.",
      fix: "Give Stackport access to /var/run/docker.sock: mount it into the Stackport container, or add its user to the docker group.",
    };
  }
  if (raw.includes("docker.sock") || raw.includes("docker daemon") || raw.includes("docker api") || raw.includes("is the docker daemon running")) {
    return {
      summary: "Stackport can't reach Docker.",
      fix: "Check that Docker is running on the server (systemctl status docker) and that /var/run/docker.sock is mounted into Stackport's container.",
    };
  }
  if (raw.includes("enoent") || raw.includes("command not found") || raw.includes("not found in $path")) {
    return {
      summary: `The command ${service} needs isn't installed where Stackport runs.`,
      fix: "Install the Docker CLI in Stackport's environment, or run Stackport with its standard container image.",
    };
  }
  if (raw.includes("no such container")) {
    return {
      summary: `The ${service} container isn't running.`,
      fix: "Start it from the Stackport folder with docker compose up -d.",
    };
  }
  return { summary: `${service} isn't available right now.`, fix: null };
}

/** Plain explanation and fix up front; the raw error stays one click away for debugging. */
export function ServiceError({ service, reason, className }: { service: string; reason: string | null | undefined; className?: string }) {
  const { summary, fix } = explainServiceError(service, reason);
  return (
    <Alert className={className}>
      <AlertCircle size={14} />
      <AlertDescription>
        <div className={styles.body}>
          <strong>{summary}</strong>
          {fix && <span>{fix}</span>}
          {reason && (
            <details className={styles.details}>
              <summary>Details</summary>
              <pre>{reason}</pre>
            </details>
          )}
        </div>
      </AlertDescription>
    </Alert>
  );
}
