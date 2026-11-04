import type { StackportNotification } from "./notificationTypes";
import { renderDeployBlockedEmail, renderDeployUnhealthyEmail, renderHealthCheckFailureEmail } from "./emailTemplates";

export function healthFailureEvent(name: string, url: string, responseMs: number | null, projectId: number,
  incidentKey: string, at = new Date().toISOString()): StackportNotification {
  return { eventKey: incidentKey, type: "health_check", severity: "error", title: `${name} is unhealthy`,
    body: "The project health check failed. Open Stackport for details.", projectName: name, projectId,
    url: `/projects/${projectId}`, createdAt: at,
    email: { subject: `[Alert] ${name} health check failed`,
      html: renderHealthCheckFailureEmail({ projectName: name, url, responseMs, occurredAt: new Date(at) }) } };
}

export function deployBlockedEvent(name: string, reason: string, projectId: number, attemptId: string | number): StackportNotification {
  return { eventKey: `deploy_blocked:${projectId}:${attemptId}`, type: "deploy_blocked", severity: "warning", title: `${name} deployment blocked`,
    body: "An automatic deployment needs your attention. Open Stackport for details.", projectName: name, projectId,
    url: `/projects/${projectId}`, createdAt: new Date().toISOString(),
    email: { subject: `[Alert] ${name} automatic deploy blocked`, html: renderDeployBlockedEmail({ projectName: name, reason, occurredAt: new Date() }) } };
}

export type DeployRollbackOutcome = "none" | "done" | "failed";
export function deployUnhealthyEvent(name: string, commitSha: string | null, url: string, rollback: DeployRollbackOutcome,
  projectId: number, deploymentId: string | number): StackportNotification {
  return { eventKey: `deploy_unhealthy:${projectId}:${deploymentId}`, type: "deploy_unhealthy", severity: "error", title: `${name} deployment is unhealthy`,
    body: rollback === "done" ? "The new deployment failed its health check. The previous version was restored." : "The deployment failed its health check. Open Stackport for details.",
    projectName: name, projectId, url: `/projects/${projectId}`, createdAt: new Date().toISOString(),
    email: { subject: `[Alert] ${name} deploy failed its health check`, html: renderDeployUnhealthyEmail({ projectName: name, commitSha, url, rollback, occurredAt: new Date() }) } };
}

export function rollbackFailedEvent(name: string, projectId: number, operationId: string): StackportNotification {
  return { eventKey: `rollback_failed:${projectId}:${operationId}`, type: "rollback_failed", severity: "error", title: `${name} rollback failed`,
    body: "Automatic rollback could not restore a healthy deployment. Open Stackport for details.", projectName: name, projectId,
    url: `/projects/${projectId}`, createdAt: new Date().toISOString() };
}

export function rollbackRecoveredEvent(name: string, projectId: number, operationId: string): StackportNotification {
  return { eventKey: `rollback_recovered:${projectId}:${operationId}`, type: "rollback_recovered", severity: "info", title: `${name} service restored`,
    body: "Automatic rollback restored the previous version and its health check passed.", projectName: name, projectId,
    url: `/projects/${projectId}`, createdAt: new Date().toISOString() };
}

export function systemUpdateFailedEvent(operationId: string, outcome: "failed" | "rolled-back"): StackportNotification {
  return { eventKey: `system_update_failed:${operationId}:${outcome}`, type: "system_update_failed", severity: "error", title: "Stackport update failed",
    body: outcome === "rolled-back" ? "The new version failed verification and was rolled back. Open Settings for details." : "The update could not complete. Open Settings for details.",
    url: "/settings/general", createdAt: new Date().toISOString() };
}
