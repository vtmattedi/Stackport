/** Human names for action kinds, shared by the project page's result line and the running-actions list. */
export const ACTION_LABEL: Record<string, string> = {
  deploy: "Redeploy",
  pull: "Pull",
  compose: "Compose up",
  build: "Rebuild",
  recreate: "Force recreate",
  "force-rebuild": "Force rebuild",
  rollback: "Roll back",
  upload: "Upload",
  stop: "Stop",
  "stop-purge": "Stop and delete data",
  "redeploy-service": "Service redeploy",
  "drop-volumes": "Drop volumes",
  "ssl-issue": "SSL issuance",
  "nginx-apply": "Nginx apply",
  "nginx-app": "Stackport domain update",
  "docker-prune": "Docker cache prune",
  "certbot-issue": "Certificate issue",
  "certbot-renew": "Certificate renewal",
  "certbot-delete": "Certificate removal",
};

export function actionLabel(kind: string): string {
  return ACTION_LABEL[kind] ?? (kind || "Action");
}
