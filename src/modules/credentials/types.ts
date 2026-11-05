// The `secret` field is never returned from API responses — only stored encrypted.
export interface Credential {
  id: number;
  type: "github" | "webhook" | "api_key";
  alias: string;
  username: string | null;
  headerName: string | null;
  isDefault: boolean;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CredentialRow {
  id: number;
  type: string;
  alias: string;
  username: string | null;
  header_name: string | null;
  secret_enc: string;
  is_default: number;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export function rowToCredential(row: CredentialRow): Credential {
  return {
    id: row.id,
    type: row.type === "github" ? "github" : row.type === "api_key" ? "api_key" : "webhook",
    alias: row.alias,
    username: row.username,
    headerName: row.header_name,
    isDefault: row.is_default === 1,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
