export interface Webhook {
  id: number;
  slug: string;
  scriptPath: string;
  description: string | null;
  enabled: boolean;
  credentialId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookRow {
  id: number;
  slug: string;
  script_path: string;
  description: string | null;
  enabled: number; // SQLite stores as 0/1
  credential_id: number | null;
  created_at: string;
  updated_at: string;
}

export function rowToWebhook(row: WebhookRow): Webhook {
  return {
    id: row.id,
    slug: row.slug,
    scriptPath: row.script_path,
    description: row.description,
    enabled: row.enabled === 1,
    credentialId: row.credential_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
