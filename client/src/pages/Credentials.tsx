import { useState, useEffect, useCallback } from "react";
import { ShieldCheck, Plus, Trash2, Eye, EyeOff, Loader, Star } from "lucide-react";
import { useConfirm } from "../components/ConfirmDialog";
import { AppSelect } from "../components/AppSelect";
import { api, ApiError } from "../api/client";
import type { Credential } from "../api/types";
import { formatShortDate } from "../lib/format";
import { notify } from "../lib/notify";

const CREDENTIAL_TYPE_OPTIONS = [
  { value: "github", label: "GitHub" },
  { value: "api_key", label: "API Key" },
];

function typeLabel(type: string): string {
  return type === "github" ? "GitHub" : type === "api_key" ? "API Key" : "Webhook";
}

export default function Credentials() {
  const confirm = useConfirm();
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);

  const [credentialType, setCredentialType] = useState<"github" | "api_key">("github");
  const [alias, setAlias] = useState("");
  const [username, setUsername] = useState("");
  const [secret, setSecret] = useState("");
  const [description, setDescription] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [addError, setAddError] = useState("");
  const [adding, setAdding] = useState(false);
  const [savingDefaultId, setSavingDefaultId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const items = await api.listCredentials();
      setCredentials(items.filter((item) => item.type === "github" || item.type === "api_key"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setAddError("");
    setAdding(true);
    try {
      await api.createCredential({
        type: credentialType,
        alias,
        ...(credentialType === "github" ? { username } : {}),
        secret,
        description: description.trim() || undefined,
      });
      setAlias("");
      setUsername("");
      setSecret("");
      setDescription("");
      await load();
    } catch (err) {
      setAddError(err instanceof ApiError ? err.message : "Failed to add credential");
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(id: number, credAlias: string) {
    const ok = await confirm({
      title: `Delete ${credAlias}?`,
      description: "Any projects using this credential will be detached.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    await api.deleteCredential(id);
    await load();
  }

  async function handleToggleDefault(credential: Credential) {
    setSavingDefaultId(credential.id);
    try {
      if (credential.isDefault) {
        await api.clearDefaultCredential();
        setCredentials((items) => items.map((item) => ({ ...item, isDefault: false })));
        notify.success("Default GitHub token cleared.");
        return;
      }

      await api.setDefaultCredential(credential.id);
      setCredentials((items) => items.map((item) => ({ ...item, isDefault: item.id === credential.id })));
      notify.success(`${credential.alias} is now the default GitHub token.`);
    } catch (err) {
      notify.error(err, "Failed to update default GitHub token");
    } finally {
      setSavingDefaultId(null);
    }
  }

  return (
    <>
      <main className="main">
        <h1 className="page-title"><ShieldCheck size={20} />Credentials</h1>

        <div className="card">
          <div className="card-title"><Plus size={12} />Add Credential</div>
          {addError && <div className="alert alert-error">{addError}</div>}
          <form onSubmit={handleAdd} className="form-row">
            <div className="field">
              <label>Type</label>
              <AppSelect
                value={credentialType}
                onValueChange={(value) => setCredentialType((value as "github" | "api_key") || "github")}
                options={CREDENTIAL_TYPE_OPTIONS}
              />
            </div>
            <div className="field">
              <label>Alias <span className="hint mono">(a–z, 0–9, _ -)</span></label>
              <input
                type="text"
                placeholder={credentialType === "github" ? "github-myrepo" : "resend-api-key"}
                value={alias}
                onChange={(e) => setAlias(e.target.value)}
                required
              />
            </div>
            {credentialType === "github" && (
              <div className="field">
                <label>Username</label>
                <input
                  type="text"
                  placeholder="github-user"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                />
              </div>
            )}
            <div className="field" style={{ position: "relative" }}>
              <label>{credentialType === "github" ? "Token" : "API Key"}</label>
              <div style={{ display: "flex", gap: 4 }}>
                <input
                  type={showSecret ? "text" : "password"}
                  placeholder={credentialType === "github" ? "ghp_..." : "re_..."}
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  required
                  style={{ flex: 1 }}
                />
                <button
                  type="button"
                  className="btn-icon"
                  onClick={() => setShowSecret((v) => !v)}
                  title={showSecret ? "Hide" : "Show"}
                  tabIndex={-1}
                >
                  {showSecret ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>
            <div className="field field-wide">
              <label>Description <span className="hint mono">(optional)</span></label>
              <input
                type="text"
                placeholder={credentialType === "github" ? "GitHub token for private repo" : "Resend API key"}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <button type="submit" className="btn btn-primary" disabled={adding}>
              <Plus size={14} />{adding ? "Adding…" : "Add"}
            </button>
          </form>
        </div>

        <div className="card">
          <div className="card-title"><ShieldCheck size={12} />Credentials</div>
          <p className="hint" style={{ marginBottom: 12 }}>
            Secrets are stored AES-256-GCM encrypted. They are never returned by the API.
          </p>
          {loading ? (
            <div className="empty">Loading…</div>
          ) : credentials.length === 0 ? (
            <div className="empty">No credentials yet.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Alias</th>
                    <th>Type</th>
                    <th>Username</th>
                    <th>Description</th>
                    <th>Secret</th>
                    <th>Default</th>
                    <th>Created</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {credentials.map((c) => (
                    <tr key={c.id}>
                      <td><span className="mono">{c.alias}</span></td>
                      <td>{typeLabel(c.type)}</td>
                      <td>
                        <span className="mono">
                          {c.type === "github" ? (c.username ?? "Missing username") : "—"}
                        </span>
                      </td>
                      <td>{c.description ?? <span className="muted-text">—</span>}</td>
                      <td><span className="muted-text mono">••••••••</span></td>
                      <td>
                        {c.type === "github" ? (
                          <button
                            type="button"
                            className={c.isDefault ? "btn btn-secondary btn-sm" : "btn btn-ghost btn-sm"}
                            onClick={() => void handleToggleDefault(c)}
                            title={c.isDefault ? "Clear default token" : "Make default token"}
                            disabled={savingDefaultId === c.id}
                          >
                            {savingDefaultId === c.id ? (
                              <Loader size={12} className="spin" />
                            ) : (
                              <Star size={12} fill={c.isDefault ? "currentColor" : "none"} />
                            )}
                            {c.isDefault ? "Default" : "Set"}
                          </button>
                        ) : (
                          <span className="muted-text">—</span>
                        )}
                      </td>
                      <td className="mono">{formatShortDate(c.createdAt)}</td>
                      <td>
                        <div className="row-actions">
                          <button
                            className="btn btn-danger"
                            onClick={() => void handleDelete(c.id, c.alias)}
                          >
                            <Trash2 size={12} />Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </>
  );
}
