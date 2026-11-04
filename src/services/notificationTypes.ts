export const PUSH_EVENT_TYPES = ["health_check", "deploy_blocked", "deploy_unhealthy", "rollback_failed", "system_update_failed"] as const;
export type NotificationEventType = typeof PUSH_EVENT_TYPES[number];

export interface StackportNotification {
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
