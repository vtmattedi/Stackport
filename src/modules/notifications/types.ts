export const PUSH_EVENT_TYPES = ["health_check", "deploy_blocked", "deploy_unhealthy", "rollback_failed", "rollback_recovered", "system_update_failed", "certificate_expiring", "certificate_renewal_failed"] as const;
export type NotificationEventType = typeof PUSH_EVENT_TYPES[number];

export interface StackportNotification {
  eventKey?: string;
  type: NotificationEventType | "test";
  severity: "info" | "warning" | "error";
  title: string;
  body: string;
  url: string;
  createdAt: string;
  projectId?: number;
  projectName?: string;
  email?: { subject: string; html: string };
}

export interface DurablePushEvent {
  eventKey: string;
  type: NotificationEventType;
  severity: "info" | "warning" | "error";
  title: string;
  body: string;
  url: string;
  projectId?: number;
  createdAt: string;
  expiresAt?: string;
}

export const PUSH_LIFETIME_MS: Record<NotificationEventType, number> = {
  health_check: 3_600_000,
  deploy_blocked: 6 * 3_600_000,
  deploy_unhealthy: 12 * 3_600_000,
  rollback_failed: 24 * 3_600_000,
  rollback_recovered: 3_600_000,
  system_update_failed: 24 * 3_600_000,
  certificate_expiring: 24 * 3_600_000,
  certificate_renewal_failed: 24 * 3_600_000,
};
