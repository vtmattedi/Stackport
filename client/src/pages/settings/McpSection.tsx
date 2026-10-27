import { useEffect, useState } from "react";
import { Copy, KeyRound, Loader, Plus, Trash2 } from "lucide-react";
import { AppSelect } from "../../components/AppSelect";
import { useConfirm } from "../../components/ConfirmDialog";
import { TimeAgo } from "../../components/TimeAgo";
import { api } from "../../api/client";
import type { ApiToken } from "../../api/types";
import { notify } from "../../lib/notify";
import styles from "../Settings.module.scss";

const EXPIRY_OPTIONS = [
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
  { value: "never", label: "Never" },
];

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    notify.success(`${what} copied.`);
  } catch (err) {
    notify.error(err, `Couldn't copy ${what.toLowerCase()}`);
  }
}

function tokenState(token: ApiToken): string {
  if (token.revokedAt) return "Revoked";
  if (token.expiresAt && Date.parse(token.expiresAt) <= Date.now()) return "Expired";
  return "Active";
}

/** API tokens for the read-only MCP endpoint at /mcp. */
export default function McpSection() {
  const confirm = useConfirm();
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState("90");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ token: string; name: string } | null>(null);

  const endpoint = `${window.location.origin}/mcp`;

  async function load() {
    try {
      setTokens(await api.listApiTokens());
    } catch (err) {
      notify.error(err, "Couldn't load API tokens");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      const result = await api.createApiToken(name.trim(), expiry === "never" ? null : Number(expiry));
      setCreated({ token: result.token, name: result.record.name });
      setName("");
      void load();
    } catch (err) {
      notify.error(err, "Couldn't create the token");
    } finally {
      setCreating(false);
    }
  }

  async function revoke(token: ApiToken) {
    const ok = await confirm({
      title: `Revoke "${token.name}"?`,
      description: "Clients using this token lose access immediately. This can't be undone.",
      confirmLabel: "Revoke",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.revokeApiToken(token.id);
      notify.success("Token revoked.");
      void load();
    } catch (err) {
      notify.error(err, "Couldn't revoke the token");
    }
  }

  const command = created
    ? `claude mcp add --transport http stackport ${endpoint} --header "Authorization: Bearer ${created.token}"`
    : "";

  return (
    <>
      <div className="card" style={{ maxWidth: 720 }}>
        <div className="card-title"><KeyRound size={13} />API tokens</div>
        <p className="hint" style={{ marginBottom: 12 }}>
          Tokens give read-only access to <span className="mono">{endpoint}</span>: project status, repository, branch,
          health, recent deployments and containers. They never expose credentials, env files or logs.
          Works with Claude Code and Claude Desktop. claude.ai connectors need OAuth, which isn't supported yet.
        </p>

        {created && (
          <div className="alert alert-success" style={{ display: "grid", gap: 8 }}>
            <strong>Token "{created.name}" created. Copy it now: it won't be shown again.</strong>
            <code className="mono" style={{ wordBreak: "break-all" }}>{created.token}</code>
            <div className="row-actions" style={{ justifyContent: "flex-start" }}>
              <button type="button" className="btn btn-ghost" onClick={() => void copy(created.token, "Token")}>
                <Copy size={13} />Copy token
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => void copy(command, "Command")}>
                <Copy size={13} />Copy Claude Code command
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setCreated(null)}>Done</button>
            </div>
          </div>
        )}

        <form className={styles.settingsForm} onSubmit={(e) => void create(e)}>
          <div className="field">
            <label>Name</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. laptop Claude Code" maxLength={80} required />
          </div>
          <div className="field" style={{ minWidth: 140, flex: "none" }}>
            <label>Expires</label>
            <AppSelect value={expiry} onValueChange={setExpiry} options={EXPIRY_OPTIONS} />
          </div>
          <div className="row-actions">
            <button type="submit" className="btn btn-primary" disabled={creating || !name.trim()}>
              {creating ? <Loader size={13} className="spin" /> : <Plus size={13} />}
              Create token
            </button>
          </div>
        </form>

        {loading ? (
          <div className="muted-text">Loading…</div>
        ) : tokens.length === 0 ? (
          <div className="muted-text">No tokens yet.</div>
        ) : (
          <div className="table-wrap" style={{ marginTop: 16 }}>
            <table>
              <thead>
                <tr><th>Name</th><th>Token</th><th>State</th><th>Last used</th><th>Expires</th><th /></tr>
              </thead>
              <tbody>
                {tokens.map((token) => {
                  const state = tokenState(token);
                  return (
                    <tr key={token.id}>
                      <td>{token.name}</td>
                      <td className="mono">{token.prefix}…</td>
                      <td style={{ color: state === "Active" ? "var(--success)" : "var(--dim)" }}>{state}</td>
                      <td>{token.lastUsedAt ? <TimeAgo ts={token.lastUsedAt} /> : "Never"}</td>
                      <td>{token.expiresAt ? new Date(token.expiresAt).toLocaleDateString() : "Never"}</td>
                      <td>
                        {state === "Active" && (
                          <button type="button" className="btn btn-ghost" onClick={() => void revoke(token)} aria-label={`Revoke ${token.name}`}>
                            <Trash2 size={13} />Revoke
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
