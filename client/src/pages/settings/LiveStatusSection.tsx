import { useCallback, useEffect, useState } from "react";
import { Copy, KeyRound, Loader, Plus, Radio, ShieldAlert } from "lucide-react";
import { api } from "../../api/client";
import type { ApiToken, StatusStreamInfo } from "../../api/types";
import { ApiTokenRow, copyText } from "../../components/ApiTokenRow";
import { AppSelect } from "../../components/AppSelect";
import { useConfirm } from "../../components/ConfirmDialog";
import { Disclosure } from "../../components/Disclosure";
import { TimeAgo } from "../../components/TimeAgo";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { CheckRow, Field } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { Stack } from "../../components/ui/stack";
import { Switch } from "../../components/ui/switch";
import { Hint, Prose } from "../../components/ui/text";
import { useSystemSelector } from "../../context/SystemContext";
import { notify } from "../../lib/notify";

const EXPIRY_OPTIONS = [
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
];
const ALL_PROJECTS = "";

const sameGroups = (a: (string | null)[], b: (string | null)[]): boolean => a.length === b.length && a.every((value, index) => value === b[index]);

const EXAMPLE = `import WebSocket from "ws";

// The token goes in a header, never in the address.
const ws = new WebSocket("wss://YOUR-STACKPORT/status/ws", {
  headers: { Authorization: \`Bearer \${process.env.STACKPORT_TOKEN}\` },
});

ws.on("message", (raw) => {
  const message = JSON.parse(String(raw));
  // hello      who this is and which sections to expect
  // snapshot   everything, once, right after hello
  // update     one section ("host", "projects", "actions", "alerts") whenever it changes
  // heartbeat  every 30 s, so you can tell a quiet stream from a dead one
});`;

/** Settings > Live status: turn the secured status WebSocket on, make tokens for the adapters that read it, and see who is connected. */
export default function LiveStatusSection() {
  const confirm = useConfirm();
  const [info, setInfo] = useState<StatusStreamInfo | null>(null);
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [toggling, setToggling] = useState(false);
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState("90");
  const [group, setGroup] = useState(ALL_PROJECTS);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ token: string; name: string } | null>(null);
  const groupNames = useSystemSelector((snap) => (snap.projects ?? []).map((project) => project.groupName), sameGroups);
  const groups = [...new Set(groupNames.filter((groupName): groupName is string => !!groupName))].sort((a, b) => a.localeCompare(b));

  const load = useCallback(async () => {
    try {
      const [next, all] = await Promise.all([api.getStatusStream(), api.listApiTokens()]);
      setInfo(next);
      setTokens(all.filter((token) => token.scopes.includes("status")));
    } catch (err) {
      notify.error(err, "Couldn't load the live status settings");
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { void load(); }, 10_000);
    return () => window.clearInterval(timer);
  }, [load]);

  async function toggle(enabled: boolean) {
    if (!enabled) {
      const ok = await confirm({
        title: "Turn the live status stream off?",
        description: `${info?.connections.length ?? 0} connected adapters are disconnected now, and the endpoint stops existing until it is turned on again. Tokens are kept.`,
        confirmLabel: "Turn off",
        destructive: true,
      });
      if (!ok) return;
    }
    setToggling(true);
    try {
      setInfo(await api.setStatusStream(enabled));
    } catch (err) {
      notify.error(err, "Couldn't change the live status stream");
    } finally {
      setToggling(false);
    }
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setCreating(true);
    try {
      const result = await api.createApiToken(name.trim(), Number(expiry), "status", group === ALL_PROJECTS ? null : group);
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
      description: "An adapter using this token is disconnected within about 30 seconds and cannot reconnect. This can't be undone.",
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

  const secure = window.location.protocol === "https:";
  const endpoint = info ? `${secure ? "wss" : "ws"}://${window.location.host}${info.path}` : "";

  if (!info) return <Loader size={14} className="spin" />;

  return (
    <Stack gap={4}>
      <div className="card mb-0!">
        <div className="card-title"><Radio size={13} />The stream</div>
        <Stack gap={4}>
          <Prose>
            Streams the host's CPU, memory, disk and network, every project's state and traffic (p95 and server-error rate), the actions running now, and alerts: things that are wrong at this moment,
            like the ones on Insights. It only ever sends. An adapter you run connects to it and passes the data on, for example to MQTT.
          </Prose>
          <CheckRow
            control={<Switch checked={info.enabled} disabled={toggling} onCheckedChange={(value) => void toggle(value)} />}
            title={info.enabled ? "The stream is on" : "The stream is off"}
            hint={info.enabled ? "Anything with a live status token can connect over HTTPS." : "While it is off the endpoint does not exist: a connection gets the same answer as for a page that was never there."}
          />
          {info.enabled && (
            <Field label="Address" htmlFor="live-status-endpoint" hint={`This Stackport is named ${info.instance} in the stream's first message.`}>
              <div className="flex max-w-xl gap-2">
                <Input id="live-status-endpoint" readOnly value={endpoint} className="font-mono text-xs" />
                <Button type="button" variant="outline" onClick={() => void copyText(endpoint, "Address")}><Copy size={13} />Copy</Button>
              </div>
            </Field>
          )}
          {info.enabled && !secure && (
            <Alert variant="destructive">
              <ShieldAlert size={14} />
              <AlertDescription>
                You are viewing Stackport over plain HTTP. The stream refuses connections that are not over HTTPS (or from this machine itself), so an adapter on another machine cannot use it until Stackport is served over HTTPS.
              </AlertDescription>
            </Alert>
          )}
        </Stack>
      </div>

      {info.enabled && (
        <div className="card mb-0!">
          <div className="card-title">Connected adapters<span className="ml-2 font-normal normal-case">{info.connections.length} of {info.limits.maxConnections}</span></div>
          {info.connections.length === 0 ? (
            <Hint>Nothing is connected. A token can hold up to {info.limits.maxConnectionsPerToken} connections at once.</Hint>
          ) : (
            <ul>
              {info.connections.map((connection, index) => (
                <li key={`${connection.tokenName}-${connection.since}-${index}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border py-2.5 text-[13px] last:border-b-0">
                  <span className="font-medium">{connection.tokenName}</span>
                  <span className="mono">{connection.address}</span>
                  {connection.group && <Badge variant="outline">group {connection.group}</Badge>}
                  <span className="text-xs text-[var(--dim)]">connected <TimeAgo ts={connection.since} /></span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="card mb-0!">
        <div className="card-title"><KeyRound size={13} />Tokens for adapters</div>
        <Stack gap={4}>
          <Hint>
            A live status token can only open this stream. It cannot use MCP or change anything, and the other tokens cannot open the stream. Limited to a project group, it sees only that group's projects, actions and alerts, and no host data.
          </Hint>

          {created && (
            <div className="alert alert-success mb-0!" style={{ display: "grid", gap: 8 }}>
              <strong>Token "{created.name}" created. Copy it now: it won't be shown again.</strong>
              <code className="mono" style={{ wordBreak: "break-all" }}>{created.token}</code>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => void copyText(created.token, "Token")}><Copy size={13} />Copy token</Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setCreated(null)}>Done</Button>
              </div>
            </div>
          )}

          <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => void create(event)}>
            <Field label="Name" htmlFor="live-status-token-name" className="min-w-[220px] flex-1 basis-60">
              <Input id="live-status-token-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. mqtt bridge" maxLength={80} required />
            </Field>
            <Field label="Sees" className="w-44 flex-none">
              <AppSelect value={group} onValueChange={setGroup} options={[{ value: ALL_PROJECTS, label: "Everything" }, ...groups.map((groupName) => ({ value: groupName, label: `Group: ${groupName}` }))]} />
            </Field>
            <Field label="Expires" className="w-36 flex-none">
              <AppSelect value={expiry} onValueChange={setExpiry} options={EXPIRY_OPTIONS} />
            </Field>
            <Button type="submit" disabled={creating || !name.trim()}>
              {creating ? <Loader size={13} className="spin" /> : <Plus size={13} />}
              Create token
            </Button>
          </form>

          {tokens.length === 0 ? <Hint>No live status tokens yet.</Hint> : (
            <ul>{tokens.map((token) => <ApiTokenRow key={token.id} token={token} access={token.projectGroup ? `Live status: group "${token.projectGroup}"` : "Live status: everything"} onRevoke={(t) => void revoke(t)} />)}</ul>
          )}
        </Stack>
      </div>

      <Disclosure title="Connect an adapter" meta="the protocol and what keeps it safe">
        <Stack gap={4}>
          <pre className="output-block overflow-x-auto text-xs">{EXAMPLE}</pre>
          <Hint>
            Messages are JSON, one per frame, all from the server. Each carries a protocol version (<span className="mono">v</span>) and, after hello, a rising <span className="mono">seq</span>.
            Alerts are conditions that hold now, each with a stable <span className="mono">id</span>: compare two lists to see what appeared and what cleared.
          </Hint>
          <ul className="grid list-disc gap-1.5 pl-5 text-xs text-[var(--dim)]">
            <li>Only over HTTPS. The token goes in the Authorization header; an address with a token in it is refused.</li>
            <li>Browsers are refused (any Origin header). The server ignores anything the adapter sends and closes the connection if it sends data.</li>
            <li>A revoked, expired or out-of-scope token ends its connection within about 30 seconds. Failed attempts lock an address out for 15 minutes after {10}.</li>
            <li>Send nothing for 60 seconds and Nginx drops an idle connection; the server's heartbeat every 30 seconds prevents that.</li>
          </ul>
        </Stack>
      </Disclosure>
    </Stack>
  );
}
