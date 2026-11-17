import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe, Loader, Lock, Plus, Trash2 } from "lucide-react";
import { api } from "../../api/client";
import type { ComposeIngressTarget, ManagedDomain, PeerTarget, ProjectDomain } from "../../api/types";
import { AppSelect } from "../../components/AppSelect";
import { useConfirm } from "../../components/ConfirmDialog";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Field } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { notify } from "../../lib/notify";
import { usePeerCall } from "../../lib/usePeerCall";

/** A project's hostnames on a peer: add one under the peer's own base domains, choose where it routes, switch TLS on, and remove it. The peer applies and owns all of it. */
export function PeerDomains({ peer, projectId }: { peer: PeerTarget; projectId: number }) {
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const canWrite = peer.grants.includes("projects:write");
  const call = usePeerCall(peer.id);
  const key = ["peers", peer.id, "project", projectId, "domains"] as const;
  const domains = useQuery({ queryKey: key, queryFn: () => api.peerRequest<ProjectDomain[]>(peer.id, "GET", `/projects/${projectId}/domains`), retry: false });
  const targets = useQuery({ queryKey: [...key, "targets"], queryFn: () => api.peerRequest<ComposeIngressTarget[]>(peer.id, "GET", `/projects/${projectId}/ingress-targets`), retry: false });
  const bases = useQuery({ queryKey: ["peers", peer.id, "managed-domains"], queryFn: () => api.peerRequest<{ domains: ManagedDomain[] }>(peer.id, "GET", "/domains"), retry: false });

  const [hostname, setHostname] = useState("");
  const [route, setRoute] = useState("");
  const [busy, setBusy] = useState(false);
  const targetList = targets.data ?? [];
  const chosen = targetList.find((target) => `${target.service}:${target.containerPort}` === route) ?? targetList[0];
  const base = bases.data?.domains.find((domain) => domain.isDefault) ?? bases.data?.domains[0];

  const reload = (): void => { void queryClient.invalidateQueries({ queryKey: key }); };

  async function act(label: string, work: () => Promise<unknown>) {
    setBusy(true);
    try { await work(); reload(); } catch (err) { notify.error(err, `${label} failed on ${peer.name}`); } finally { setBusy(false); }
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!chosen) return;
    await act("Adding the hostname", async () => {
      await call("POST", `/projects/${projectId}/domains`, { domain: hostname.trim().toLowerCase(), service: chosen.service, containerPort: chosen.containerPort });
      setHostname("");
    });
  }

  async function remove(domain: ProjectDomain) {
    const ok = await confirm({ title: `Remove ${domain.domain} from ${peer.name}?`, description: `The hostname stops routing to this project on ${peer.name}.`, confirmLabel: "Remove", destructive: true });
    if (ok) await act("Removing the hostname", () => call("DELETE", `/projects/${projectId}/domains/${domain.id}`));
  }

  return (
    <div className="card">
      <div className="card-title"><Globe size={13} />Hostnames on {peer.name}</div>
      {domains.isLoading ? <Loader size={14} className="spin" /> : domains.error ? <Alert variant="destructive"><AlertDescription>{domains.error instanceof Error ? domains.error.message : "Couldn't read the hostnames."}</AlertDescription></Alert> : (
        <ul>
          {(domains.data ?? []).length === 0 && <li className="py-2 text-[13px] text-[var(--dim)]">No hostnames yet.</li>}
          {(domains.data ?? []).map((domain) => (
            <li key={domain.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border py-2.5 text-[13px] last:border-b-0">
              <span className="mono font-medium">{domain.domain}</span>
              <span className="text-xs text-[var(--dim)]">{domain.containerPort ? `→ ${domain.service}:${domain.containerPort}` : "no route yet"}</span>
              {domain.useSsl ? <Badge><Lock size={10} />TLS</Badge> : <Badge variant="outline">HTTP</Badge>}
              {canWrite && (
                <span className="ml-auto flex gap-1.5">
                  <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void act("Changing TLS", () => call("PATCH", `/projects/${projectId}/domains/${domain.id}`, { useSsl: !domain.useSsl }))}>{domain.useSsl ? "Turn TLS off" : "Turn TLS on"}</Button>
                  {domain.useSsl && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void act("Requesting the certificate", () => call("POST", `/projects/${projectId}/domains/${domain.id}/ssl/issue`))}>Issue certificate</Button>}
                  <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void remove(domain)}><Trash2 size={13} />Remove</Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {canWrite && (
        <form className="mt-4 flex flex-wrap items-end gap-3" onSubmit={(event) => void add(event)}>
          <Field label="Hostname" htmlFor="peer-hostname" className="min-w-[240px] flex-1 basis-64" hint={base ? `Under one of ${peer.name}'s base domains, for example name.${base.name}.` : `${peer.name} manages no base domain yet.`}>
            <Input id="peer-hostname" value={hostname} onChange={(event) => setHostname(event.target.value)} placeholder={base ? `app.${base.name}` : "app.example.com"} className="font-mono text-xs" required />
          </Field>
          <Field label="Routes to" className="w-56 flex-none" hint={targetList.length === 0 ? "No service with a port found yet: deploy the project first." : undefined}>
            <AppSelect value={chosen ? `${chosen.service}:${chosen.containerPort}` : ""} onValueChange={setRoute} placeholder="Service" disabled={targetList.length === 0} options={targetList.map((target) => ({ value: `${target.service}:${target.containerPort}`, label: `${target.service}:${target.containerPort}` }))} />
          </Field>
          <Button type="submit" disabled={busy || !hostname.trim() || !chosen}>{busy ? <Loader size={13} className="spin" /> : <Plus size={13} />}Add hostname</Button>
        </form>
      )}
    </div>
  );
}
