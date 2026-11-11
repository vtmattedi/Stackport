import { useEffect, useState } from "react";
import { Copy, KeyRound, Loader, Plus, Search, Trash2, Wrench } from "lucide-react";
import { AppSelect } from "../../components/AppSelect";
import { useConfirm } from "../../components/ConfirmDialog";
import { TimeAgo } from "../../components/TimeAgo";
import { api } from "../../api/client";
import type { ApiToken, McpToolInfo } from "../../api/types";
import { useSystemSelector } from "../../context/SystemContext";
import { notify } from "../../lib/notify";
import styles from "../Settings.module.scss";
import mcp from "./McpSection.module.scss";

const EXPIRY_OPTIONS = [
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
  { value: "never", label: "Never" },
];

const SCOPE_OPTIONS = [
  { value: "read", label: "Read only" },
  { value: "write", label: "Read and write" },
];

const ALL_PROJECTS = "";

function sameGroups(a: (string | null)[], b: (string | null)[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function accessLabel(token: ApiToken): string {
  if (!token.scopes.includes("write")) return "Read only";
  return token.projectGroup ? `Read and write: group "${token.projectGroup}"` : "Read and write: all projects";
}

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

type ToolFilter = "all" | "read" | "write";

/** The tools the endpoint offers, read back from the server so the list is what a client really gets. */
function ToolExplorer() {
  const [tools, setTools] = useState<McpToolInfo[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ToolFilter>("all");

  useEffect(() => {
    let live = true;
    api.listMcpTools().then(({ tools: list }) => { if (live) setTools(list); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);

  const needle = query.trim().toLowerCase();
  const shown = (tools ?? []).filter((tool) =>
    (filter === "all" || tool.scope === filter)
    && (!needle || `${tool.name} ${tool.title} ${tool.description}`.toLowerCase().includes(needle)));
  const counts = { read: (tools ?? []).filter((t) => t.scope === "read").length, write: (tools ?? []).filter((t) => t.scope === "write").length };

  return (
    <div className="card">
      <div className="card-title"><Wrench size={13} />Tools</div>
      <p className="hint" style={{ maxWidth: "80ch" }}>
        What a client sees on <span className="mono">/mcp</span>. A <strong>read</strong> token gets the read tools; a <strong>read and write</strong> token also gets the write tools.
        Every write tool takes two calls: the first only says what would happen, and the change runs only when the second presents the confirmation it returned.
      </p>
      {failed ? (
        <div className={mcp.empty}>The tool list could not be loaded.</div>
      ) : !tools ? (
        <div className={mcp.empty}>Loading…</div>
      ) : (
        <>
          <div className={mcp.explorerBar}>
            <div className={mcp.explorerSearch} style={{ position: "relative" }}>
              <Search size={13} style={{ position: "absolute", left: 10, top: 11, color: "var(--dim)" }} />
              <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search tools" aria-label="Search tools" style={{ paddingLeft: 30, width: "100%" }} />
            </div>
            <div className={mcp.filters} role="group" aria-label="Filter tools">
              {([["all", `All ${tools.length}`], ["read", `Read ${counts.read}`], ["write", `Write ${counts.write}`]] as const).map(([value, label]) => (
                <button key={value} type="button" className={mcp.filter} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>
              ))}
            </div>
          </div>
          {shown.length === 0 ? (
            <div className={mcp.empty}>No tool matches.</div>
          ) : (
            <div className={mcp.tools}>
              {shown.map((tool) => (
                <details key={tool.name} className={mcp.tool}>
                  <summary>
                    <span className={mcp.toolName}>{tool.name}</span>
                    <span className={`${mcp.badge} ${tool.scope === "write" ? mcp.badgeWrite : mcp.badgeRead}`}>{tool.scope === "write" ? "write token" : "read token"}</span>
                    {tool.twoStep && <span className={mcp.badge}>two calls</span>}
                    <span className={mcp.toolTitle}>{tool.title}</span>
                  </summary>
                  <div className={mcp.toolBody}>
                    <p>{tool.description}</p>
                    {tool.parameters.length === 0 ? (
                      <span className={mcp.empty}>No parameters.</span>
                    ) : (
                      <div className={mcp.paramsWrap}>
                        <table className={mcp.params}>
                          <thead><tr><th>Parameter</th><th>Type</th><th>Description</th></tr></thead>
                          <tbody>
                            {tool.parameters.map((param) => (
                              <tr key={param.name}>
                                <td>{param.name}{param.required ? <span title="required" style={{ color: "var(--warning, #d29922)" }}> *</span> : null}</td>
                                <td className="mono">{param.type}</td>
                                <td>{param.description}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </details>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** API tokens for the MCP endpoint at /mcp, and the tools they unlock. */
export default function McpSection() {
  const confirm = useConfirm();
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState("90");
  const [scope, setScope] = useState("read");
  const [group, setGroup] = useState(ALL_PROJECTS);
  const groupNames = useSystemSelector((snap) => (snap.projects ?? []).map((project) => project.groupName), sameGroups);
  const groups = [...new Set(groupNames.filter((name): name is string => !!name))].sort((a, b) => a.localeCompare(b));
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
      const result = await api.createApiToken(
        name.trim(),
        expiry === "never" ? null : Number(expiry),
        scope === "write" ? "write" : "read",
        scope === "write" && group !== ALL_PROJECTS ? group : null,
      );
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
    <div className={styles.sectionStack}>
      <ToolExplorer />
      <div className="card">
        <div className="card-title"><KeyRound size={13} />API tokens</div>
        <p className="hint" style={{ marginBottom: 12, maxWidth: "80ch" }}>
          A token gives access to <span className="mono">{endpoint}</span>. Read tokens never expose credentials, env files or logs. A <strong>read and write</strong> token can change things in all projects or in one project group (a project it creates goes into that group). Every change is written to the audit log. Works with Claude Code and Claude Desktop; claude.ai connectors need OAuth, which isn't supported yet.
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

        <form className={mcp.createForm} onSubmit={(e) => void create(e)}>
          <div className={`field ${mcp.createName}`}>
            <label>Name</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. laptop Claude Code" maxLength={80} required />
          </div>
          <div className="field" style={{ minWidth: 150, flex: "none" }}>
            <label>Access</label>
            <AppSelect value={scope} onValueChange={setScope} options={SCOPE_OPTIONS} />
          </div>
          {scope === "write" && (
            <div className="field" style={{ minWidth: 170, flex: "none" }}>
              <label>Projects</label>
              <AppSelect
                value={group}
                onValueChange={setGroup}
                options={[{ value: ALL_PROJECTS, label: "All projects" }, ...groups.map((name) => ({ value: name, label: `Group: ${name}` }))]}
              />
            </div>
          )}
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
                <tr><th>Name</th><th>Token</th><th>Access</th><th>State</th><th>Last used</th><th>Expires</th><th /></tr>
              </thead>
              <tbody>
                {tokens.map((token) => {
                  const state = tokenState(token);
                  return (
                    <tr key={token.id}>
                      <td>{token.name}</td>
                      <td className="mono">{token.prefix}…</td>
                      <td>{accessLabel(token)}</td>
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
    </div>
  );
}
