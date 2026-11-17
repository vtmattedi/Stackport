import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Copy, Link2, FolderDot, Loader, Plus, RefreshCw, ShieldAlert, Trash2 } from "lucide-react";
import { api } from "../../api/client";
import type { PairingCodeResult, PeerController, PeerGrant, PeerState, PeerTarget } from "../../api/types";
import { copyText } from "../../components/ApiTokenRow";
import { AppSelect } from "../../components/AppSelect";
import { useConfirm } from "../../components/ConfirmDialog";
import { TimeAgo } from "../../components/TimeAgo";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Field } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { Stack } from "../../components/ui/stack";
import { Hint, Prose } from "../../components/ui/text";
import { notify } from "../../lib/notify";
import { PEER_STATE } from "../../lib/peerState";
import { usePeers } from "../../lib/usePeers";

const GRANT_INFO: Record<PeerGrant, { label: string; hint: string }> = {
  "projects:read": { label: "View", hint: "List projects and see their status, logs and history." },
  "projects:write": { label: "Manage", hint: "Create, configure, deploy, restart, roll back, domains and routing. Includes running arbitrary containers, which on this host is as powerful as root." },
  "projects:env": { label: "Environment", hint: "Read and edit env files. Secret values stay masked." },
  "projects:secrets": { label: "Reveal secrets", hint: "See secret values in clear text." },
  "projects:shell": { label: "Shell", hint: "Open a shell inside a project's containers." },
  "projects:destroy": { label: "Delete", hint: "Delete projects and their data." },
  "projects:transfer": { label: "Move projects", hint: "Move a project to or from this instance: all of its data and secret values travel with it. Removing the original afterwards also needs Delete." },
  "host:read": { label: "Host metrics", hint: "CPU, memory, disk, load and network of this machine, and the alerts about it. Read only: host administration can never be granted." },
};

/** Granting one of these also grants what it needs; the server says which, so the form shows the set it will actually issue. */
const expand = (picked: PeerGrant[], implications: Record<PeerGrant, PeerGrant[]>): PeerGrant[] => [...new Set(picked.flatMap((grant) => [grant, ...(implications[grant] ?? [])]))];


const TTL_OPTIONS = [
  { value: "10", label: "10 minutes" },
  { value: "30", label: "30 minutes" },
  { value: "60", label: "1 hour" },
];

const isIpHost = (host: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");

function GrantBadges({ grants }: { grants: PeerGrant[] }) {
  return <>{grants.map((grant) => <Badge key={grant} variant="outline">{GRANT_INFO[grant]?.label ?? grant}</Badge>)}</>;
}

/** Settings > Peers: name this instance, let another Stackport control it (a pairing code), and control others (paste one). */
export default function PeersSection() {
  const confirm = useConfirm();
  // One query for the sidebar, the peer pages and this page: there is a single copy of the peers.
  const { data = null, refetch } = usePeers();
  const [name, setName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [picked, setPicked] = useState<PeerGrant[]>(["projects:read"]);
  const [ttl, setTtl] = useState("30");
  const [endpoint, setEndpoint] = useState(window.location.origin);
  const [fingerprint, setFingerprint] = useState("");
  const [issuing, setIssuing] = useState(false);
  const [issued, setIssued] = useState<PairingCodeResult | null>(null);
  const [code, setCode] = useState("");
  const [registering, setRegistering] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    try { await refetch({ throwOnError: true }); } catch (err) { notify.error(err, "Couldn't load the peers"); }
  }, [refetch]);

  useEffect(() => {
    const timer = window.setInterval(() => { void load(); }, 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  // The first answer fills the fields that start from what this instance already knows.
  useEffect(() => {
    if (!data) return;
    setName((current) => current || data.self.name);
    setFingerprint((current) => current || (data.selfSignedFingerprint && isIpHost(window.location.hostname) ? data.selfSignedFingerprint : ""));
  }, [data]);

  async function saveName(event: React.FormEvent) {
    event.preventDefault();
    setSavingName(true);
    try {
      await api.renameSelf(name.trim());
      notify.success("Renamed. Peers pick up the new name within a minute.");
      void load();
    } catch (err) {
      notify.error(err, "Couldn't rename this instance");
    } finally {
      setSavingName(false);
    }
  }

  function toggle(grant: PeerGrant, on: boolean) {
    setPicked((current) => {
      const next = on ? [...current, grant] : current.filter((entry) => entry !== grant);
      return next;
    });
  }

  async function issue(event: React.FormEvent) {
    event.preventDefault();
    const final = expand(picked, data?.grantImplications ?? ({} as Record<PeerGrant, PeerGrant[]>));
    if (final.length === 0) return;
    if (final.some((grant) => grant === "projects:secrets" || grant === "projects:shell" || grant === "projects:destroy" || grant === "projects:transfer")) {
      const ok = await confirm({
        title: "Grant this much access?",
        description: "Whoever holds this code and uses it first controls this instance with these powers, until you revoke them. Hand it over only through a channel you trust.",
        confirmLabel: "Create code",
        destructive: true,
      });
      if (!ok) return;
    }
    setIssuing(true);
    try {
      setIssued(await api.issuePairingCode({ endpoint: endpoint.trim(), fingerprint: fingerprint.trim() || null, grants: final, ttlMinutes: Number(ttl) }));
    } catch (err) {
      notify.error(err, "Couldn't create the pairing code");
    } finally {
      setIssuing(false);
    }
  }

  async function register(event: React.FormEvent) {
    event.preventDefault();
    setRegistering(true);
    try {
      const target = await api.registerPeer(code.trim());
      notify.success(`Connected to ${target.name}.`);
      setCode("");
      void load();
    } catch (err) {
      notify.error(err, "Couldn't connect to that instance");
    } finally {
      setRegistering(false);
    }
  }

  async function refresh(target: PeerTarget) {
    setBusy(target.id);
    try {
      const status = await api.refreshPeer(target.id);
      if (status.state !== "online") notify.error(new Error(status.message ?? PEER_STATE[status.state as PeerState]?.label ?? status.state), `${target.name} is not reachable`);
      void load();
    } catch (err) {
      notify.error(err, "Couldn't check the peer");
    } finally {
      setBusy(null);
    }
  }

  async function rotate(target: PeerTarget) {
    const ok = await confirm({ title: `Rotate the key for ${target.name}?`, description: "A new key replaces the shared one. The old key stops working as soon as the new one is used.", confirmLabel: "Rotate" });
    if (!ok) return;
    setBusy(target.id);
    try {
      await api.rotatePeerKey(target.id);
      notify.success("Key rotated.");
    } catch (err) {
      notify.error(err, "Couldn't rotate the key. If it says the outcome is uncertain, run it again within the hour.");
    } finally {
      setBusy(null);
    }
  }

  async function remove(target: PeerTarget) {
    const ok = await confirm({
      title: `Stop controlling ${target.name}?`,
      description: `This forgets ${target.name} here and asks it to revoke this instance. Its projects are not touched. If it can't be reached, revoke this instance from its own Peers page.`,
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    setBusy(target.id);
    try {
      const { notified } = await api.removePeer(target.id);
      notify.success(notified ? `${target.name} removed and told.` : `${target.name} removed. It could not be told: revoke this instance there too.`);
      void load();
    } catch (err) {
      notify.error(err, "Couldn't remove the peer");
    } finally {
      setBusy(null);
    }
  }

  async function revoke(controller: PeerController) {
    const ok = await confirm({
      title: `Revoke ${controller.name}?`,
      description: `${controller.name} can no longer control this instance. It takes effect on its next request. To allow it again, create a new pairing code.`,
      confirmLabel: "Revoke",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.revokeController(controller.id);
      notify.success("Access revoked.");
      void load();
    } catch (err) {
      notify.error(err, "Couldn't revoke");
    }
  }

  async function forget(controller: PeerController) {
    try {
      await api.forgetController(controller.id);
      void load();
    } catch (err) {
      notify.error(err, "Couldn't remove the entry");
    }
  }

  if (!data) return <Loader size={14} className="spin" />;

  const finalGrants = expand(picked, data.grantImplications);
  const added = finalGrants.filter((grant) => !picked.includes(grant));
  const plainHttp = endpoint.trim().startsWith("http://");
  const activeControllers = data.controlledBy.filter((controller) => !controller.revokedAt);

  return (
    <Stack gap={4}>
      <div className="card mb-0!">
        <div className="card-title"><Link2 size={13} />This instance</div>
        <Stack gap={4}>
          <Prose>
            Peers know this Stackport by a fixed identity that never changes, and by this name, which you can change. There is no master: each pairing is one-way and states what the controlling side may do.
          </Prose>
          <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => void saveName(event)}>
            <Field label="Name" htmlFor="peer-self-name" className="min-w-[220px] flex-1 basis-60" hint={<>Identity <span className="mono">{data.self.id}</span></>}>
              <Input id="peer-self-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required />
            </Field>
            <Button type="submit" disabled={savingName || !name.trim() || name.trim() === data.self.name}>
              {savingName && <Loader size={13} className="spin" />}Save name
            </Button>
          </form>
        </Stack>
      </div>

      <div className="card mb-0!">
        <div className="card-title">Instances you control<span className="ml-2 font-normal normal-case">{data.controlling.length}</span></div>
        <Stack gap={4}>
          {data.controlling.length === 0 ? (
            <Hint>None yet. On the other Stackport, open Settings, Peers and create a pairing code, then paste it below.</Hint>
          ) : (
            <ul>
              {data.controlling.map((target) => {
                const state = PEER_STATE[target.status.state] ?? PEER_STATE.unknown;
                return (
                  <li key={target.id} className="grid gap-1.5 border-b border-border py-3 text-[13px] last:border-b-0">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="font-medium">{target.name}</span>
                      <Badge variant={state.variant}>{state.label}</Badge>
                      <span className="mono text-xs text-[var(--dim)]">{target.endpoint}</span>
                      <span className="ml-auto flex gap-1.5">
                        <Button asChild variant="outline" size="sm"><Link to={`/peers/${target.id}`}><FolderDot size={13} />Projects</Link></Button>
                        <Button type="button" variant="outline" size="sm" disabled={busy === target.id} onClick={() => void refresh(target)}>
                          {busy === target.id ? <Loader size={13} className="spin" /> : <RefreshCw size={13} />}Check
                        </Button>
                        <Button type="button" variant="outline" size="sm" disabled={busy === target.id} onClick={() => void rotate(target)}>Rotate key</Button>
                        <Button type="button" variant="ghost" size="sm" disabled={busy === target.id} onClick={() => void remove(target)}><Trash2 size={13} />Remove</Button>
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <GrantBadges grants={target.grants} />
                      <span className="text-xs text-[var(--dim)]">last seen <TimeAgo ts={target.lastSeenAt} /></span>
                    </div>
                    {target.status.message && target.status.state !== "online" && <Hint>{target.status.message}</Hint>}
                    {target.certFingerprint && <Hint>Pinned to certificate <span className="mono">{target.certFingerprint.slice(0, 23)}…</span></Hint>}
                  </li>
                );
              })}
            </ul>
          )}

          <form className="grid gap-3" onSubmit={(event) => void register(event)}>
            <Field label="Pairing code" htmlFor="peer-code" hint="Created on the instance you want to control, valid for one use.">
              <Input id="peer-code" value={code} onChange={(event) => setCode(event.target.value)} placeholder="spp1.…" className="font-mono text-xs" autoComplete="off" spellCheck={false} />
            </Field>
            <div><Button type="submit" disabled={registering || !code.trim().startsWith("spp1.")}>{registering ? <Loader size={13} className="spin" /> : <Plus size={13} />}Connect</Button></div>
          </form>
        </Stack>
      </div>

      <div className="card mb-0!">
        <div className="card-title">Let another Stackport control this one<span className="ml-2 font-normal normal-case">{activeControllers.length}</span></div>
        <Stack gap={4}>
          {data.controlledBy.length === 0 ? <Hint>Nothing controls this instance.</Hint> : (
            <ul>
              {data.controlledBy.map((controller) => (
                <li key={controller.id} className="grid gap-1.5 border-b border-border py-3 text-[13px] last:border-b-0">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-medium">{controller.name}</span>
                    {controller.revokedAt ? <Badge variant="destructive">Revoked</Badge> : <Badge>Active</Badge>}
                    <span className="text-xs text-[var(--dim)]">last used <TimeAgo ts={controller.lastUsedAt} fallback="never" /></span>
                    {controller.revokedAt
                      ? <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={() => void forget(controller)}>Remove entry</Button>
                      : <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={() => void revoke(controller)}>Revoke</Button>}
                  </div>
                  <div className="flex flex-wrap gap-1.5"><GrantBadges grants={controller.grants} /></div>
                </li>
              ))}
            </ul>
          )}

          <form className="grid gap-4" onSubmit={(event) => void issue(event)}>
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-xs font-medium text-[var(--dim)]">What it may do</legend>
              {data.grantsAvailable.map((grant) => {
                const implied = added.includes(grant);
                return (
                  <label key={grant} className="flex cursor-pointer items-start gap-2.5 text-[13px] leading-snug">
                    <Checkbox checked={picked.includes(grant) || implied} disabled={implied} onCheckedChange={(value) => toggle(grant, value === true)} className="mt-0.5" />
                    <span><strong>{GRANT_INFO[grant]?.label ?? grant}</strong>{implied && <span className="text-[var(--dim)]"> (needed by another choice)</span>}<br /><span className="text-xs text-[var(--dim)]">{GRANT_INFO[grant]?.hint}</span></span>
                  </label>
                );
              })}
              <Hint>Host settings, updates, backups and other peers can never be granted.</Hint>
            </fieldset>
            <div className="flex flex-wrap gap-3">
              <Field label="Address the other side will use" htmlFor="peer-endpoint" className="min-w-[260px] flex-1 basis-72" hint="Just the origin, for example https://sp.example.com. Must be HTTPS.">
                <Input id="peer-endpoint" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} className="font-mono text-xs" required />
              </Field>
              <Field label="Valid for" className="w-40 flex-none">
                <AppSelect value={ttl} onValueChange={setTtl} options={TTL_OPTIONS} />
              </Field>
            </div>
            <Field label="Certificate fingerprint" htmlFor="peer-fingerprint" optional hint="Needed when this instance is reached by IP address with its self-signed certificate: the other side then trusts exactly this certificate. Leave empty with a real certificate.">
              <Input id="peer-fingerprint" value={fingerprint} onChange={(event) => setFingerprint(event.target.value)} className="font-mono text-xs" spellCheck={false} />
            </Field>
            {plainHttp && (
              <Alert variant="destructive"><ShieldAlert size={14} /><AlertDescription>Plain HTTP is only accepted for this machine itself. Use an https address.</AlertDescription></Alert>
            )}
            <div><Button type="submit" disabled={issuing || finalGrants.length === 0 || !endpoint.trim()}>{issuing ? <Loader size={13} className="spin" /> : <Plus size={13} />}Create pairing code</Button></div>
          </form>

          {issued && (
            <div className="alert alert-success mb-0!" style={{ display: "grid", gap: 8 }}>
              <strong>Copy this now. It is shown once and works once, until <TimeAgo ts={issued.expiresAt} />.</strong>
              <code className="mono" style={{ wordBreak: "break-all" }}>{issued.code}</code>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => void copyText(issued.code, "Pairing code")}><Copy size={13} />Copy code</Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setIssued(null)}>Done</Button>
                <GrantBadges grants={issued.grants} />
              </div>
            </div>
          )}
        </Stack>
      </div>
    </Stack>
  );
}
