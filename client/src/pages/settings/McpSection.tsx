import { useEffect, useState } from "react";
import { Copy, KeyRound, Loader, Plus, Search, Trash2, Wrench } from "lucide-react";
import { AppSelect } from "../../components/AppSelect";
import { useConfirm } from "../../components/ConfirmDialog";
import { Disclosure } from "../../components/Disclosure";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Field } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { Stack } from "../../components/ui/stack";
import { Hint, Prose } from "../../components/ui/text";
import { TimeAgo } from "../../components/TimeAgo";
import { api } from "../../api/client";
import type { ApiToken, McpToolInfo } from "../../api/types";
import { useSystemSelector } from "../../context/SystemContext";
import { notify } from "../../lib/notify";
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

/** The tools the endpoint offers, read back from the server so the list is what a client really gets. Closed by default: it is reference material. */
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
    <Disclosure
      title={<span className="flex items-center gap-2"><Wrench size={13} />Tools a client gets</span>}
      meta={tools ? `${tools.length} tools · ${counts.read} read · ${counts.write} write` : failed ? "could not be loaded" : "loading…"}
    >
      <Stack gap={4}>
        <Hint>
          What a client sees on <span className="mono">/mcp</span>. A <strong>read</strong> token gets the read tools; a <strong>read and write</strong> token also gets the write tools.
          Every write tool takes two calls: the first only says what would happen, and the change runs only when the second presents the confirmation it returned.
        </Hint>
        {failed ? (
          <div className={mcp.empty}>The tool list could not be loaded.</div>
        ) : !tools ? (
          <div className={mcp.empty}>Loading…</div>
        ) : (
          <>
            <div className={mcp.explorerBar} style={{ margin: 0 }}>
              <div className={mcp.explorerSearch} style={{ position: "relative" }}>
                <Search size={13} style={{ position: "absolute", left: 10, top: 11, color: "var(--dim)" }} />
                <Input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search tools" aria-label="Search tools" className="pl-8" />
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
                  <Disclosure
                    key={tool.name}
                    title={(
                      <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                        <span className="font-mono text-[13px] break-all">{tool.name}</span>
                        <Badge variant="outline" className={tool.scope === "write" ? "border-[var(--warning,#d29922)] text-[var(--warning,#d29922)]" : "border-[var(--success)] text-[var(--success)]"}>{tool.scope === "write" ? "write token" : "read token"}</Badge>
                        {tool.twoStep && <Badge variant="outline">two calls</Badge>}
                      </span>
                    )}
                  >
                    <Stack gap={3}>
                      <Prose>{tool.title}. {tool.description}</Prose>
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
                    </Stack>
                  </Disclosure>
                ))}
              </div>
            )}
          </>
        )}
      </Stack>
    </Disclosure>
  );
}

/** One token: what it is on the first line, when it was last used and when it expires on the second, so it reads at any width. */
function TokenRow({ token, onRevoke }: { token: ApiToken; onRevoke: (token: ApiToken) => void }) {
  const state = tokenState(token);
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border py-3 last:border-b-0">
      <div className="grid min-w-0 flex-1 basis-64 gap-1">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="text-[13px] font-medium break-words">{token.name}</span>
          <Badge variant="outline" className={state === "Active" ? "border-[var(--success)] text-[var(--success)]" : "text-[var(--dim)]"}>{state}</Badge>
          <span className="mono">{token.prefix}…</span>
        </div>
        <div className="text-xs text-[var(--dim)]">
          {accessLabel(token)} · last used {token.lastUsedAt ? <TimeAgo ts={token.lastUsedAt} /> : "never"} · expires {token.expiresAt ? new Date(token.expiresAt).toLocaleDateString() : "never"}
        </div>
      </div>
      {state === "Active" && (
        <Button type="button" variant="outline" size="sm" onClick={() => onRevoke(token)} aria-label={`Revoke ${token.name}`}>
          <Trash2 size={13} />Revoke
        </Button>
      )}
    </li>
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
    <Stack gap={4}>
      <div className="card mb-0!">
        <div className="card-title"><KeyRound size={13} />API tokens</div>
        <Stack gap={4}>
          <Stack gap={2}>
            <Prose>A token gives access to <span className="mono">{endpoint}</span>. It works with Claude Code and Claude Desktop; claude.ai connectors need OAuth, which isn't supported yet.</Prose>
            <Hint>
              Read tokens never expose credentials, env files or logs. A <strong>read and write</strong> token can change things in all projects or in one project group (a project it creates goes
              into that group). Every change is written to the audit log.
            </Hint>
          </Stack>

          {created && (
            <div className="alert alert-success mb-0!" style={{ display: "grid", gap: 8 }}>
              <strong>Token "{created.name}" created. Copy it now: it won't be shown again.</strong>
              <code className="mono" style={{ wordBreak: "break-all" }}>{created.token}</code>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => void copy(created.token, "Token")}><Copy size={13} />Copy token</Button>
                <Button type="button" variant="outline" size="sm" onClick={() => void copy(command, "Command")}><Copy size={13} />Copy Claude Code command</Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setCreated(null)}>Done</Button>
              </div>
            </div>
          )}

          <form className={mcp.createForm} style={{ marginTop: 0 }} onSubmit={(e) => void create(e)}>
            <Field label="Name" htmlFor="mcp-token-name" className={mcp.createName}>
              <Input id="mcp-token-name" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. laptop Claude Code" maxLength={80} required />
            </Field>
            <Field label="Access" className="w-40 flex-none">
              <AppSelect value={scope} onValueChange={setScope} options={SCOPE_OPTIONS} />
            </Field>
            {scope === "write" && (
              <Field label="Projects" className="w-44 flex-none">
                <AppSelect
                  value={group}
                  onValueChange={setGroup}
                  options={[{ value: ALL_PROJECTS, label: "All projects" }, ...groups.map((name) => ({ value: name, label: `Group: ${name}` }))]}
                />
              </Field>
            )}
            <Field label="Expires" className="w-36 flex-none">
              <AppSelect value={expiry} onValueChange={setExpiry} options={EXPIRY_OPTIONS} />
            </Field>
            <Button type="submit" disabled={creating || !name.trim()}>
              {creating ? <Loader size={13} className="spin" /> : <Plus size={13} />}
              Create token
            </Button>
          </form>

          {loading ? (
            <Hint>Loading…</Hint>
          ) : tokens.length === 0 ? (
            <Hint>No tokens yet.</Hint>
          ) : (
            <ul>{tokens.map((token) => <TokenRow key={token.id} token={token} onRevoke={(t) => void revoke(t)} />)}</ul>
          )}
        </Stack>
      </div>

      <ToolExplorer />
    </Stack>
  );
}
