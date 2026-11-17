import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader, MoveRight, X } from "lucide-react";
import { api } from "../api/client";
import type { MoveEndpoint, PeerTarget } from "../api/types";
import { notify } from "../lib/notify";
import { queryKeys } from "../lib/queryKeys";
import { usePeers } from "../lib/usePeers";
import { AppSelect } from "./AppSelect";
import { MoveProgress } from "./MoveProgress";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import { Field } from "./ui/field";
import { Input } from "./ui/input";

export type MoveSource = { kind: "local" } | { kind: "peer"; peer: PeerTarget };

const sourceRef = (source: MoveSource): MoveEndpoint => (source.kind === "local" ? { kind: "local" } : { kind: "peer", peerId: source.peer.id });
const NONE = "__none__";

/** Move a project to another instance: pick where, name it, choose its hostname from that instance's own domains, then watch it and decide. */
export function MoveProjectDialog({ source, projectId, projectName, currentHostname, onClose }: { source: MoveSource; projectId: number; projectName: string; currentHostname: string | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { data: overview } = usePeers();
  const sourceName = source.kind === "local" ? overview?.self.name ?? "this instance" : source.peer.name;

  // Where it can go: every other instance that has granted moving. The reason is shown for the ones that cannot.
  const choices = useMemo(() => {
    const list: { value: string; label: string; disabled: boolean; ref: MoveEndpoint; name: string }[] = [];
    if (source.kind === "peer") list.push({ value: "local", label: `${overview?.self.name ?? "This instance"} (this instance)`, disabled: false, ref: { kind: "local" }, name: overview?.self.name ?? "this instance" });
    for (const peer of overview?.controlling ?? []) {
      if (source.kind === "peer" && peer.id === source.peer.id) continue;
      const allowed = peer.grants.includes("projects:transfer");
      const online = peer.status.state === "online";
      list.push({ value: String(peer.id), label: `${peer.name}${allowed ? (online ? "" : " — not reachable") : " — has not granted moving"}`, disabled: !allowed || !online, ref: { kind: "peer", peerId: peer.id }, name: peer.name });
    }
    return list;
  }, [overview, source]);

  const [targetValue, setTargetValue] = useState("");
  const target = choices.find((choice) => choice.value === targetValue) ?? null;
  const [name, setName] = useState(projectName);
  const [baseName, setBaseName] = useState(NONE);
  const [label, setLabel] = useState("");
  const [starting, setStarting] = useState(false);
  const [moveId, setMoveId] = useState<string | null>(null);

  useEffect(() => { if (!targetValue) setTargetValue(choices.find((choice) => !choice.disabled)?.value ?? ""); }, [choices, targetValue]);
  // Another target has other domains: what was chosen for the last one does not carry over.
  useEffect(() => { setBaseName(NONE); setLabel(""); }, [targetValue]);

  const domains = useQuery({
    queryKey: queryKeys.moveDomains(targetValue),
    queryFn: () => api.getMoveDomains((target as NonNullable<typeof target>).ref),
    enabled: !!target && !moveId,
    retry: false,
    staleTime: 0,
  });

  // Preselect what the project has now: its subdomain label, under the first domain the target manages.
  const suggestion = useMemo(() => {
    const current = currentHostname?.toLowerCase() ?? "";
    const parts = current.split(".");
    // `example.com` is the bare domain (`@`); `shop.example.com` keeps its label.
    if (parts.length === 2) return "@";
    return parts.length > 2 ? parts[0] : projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }, [currentHostname, projectName]);
  useEffect(() => {
    const bases = domains.data?.bases ?? [];
    setLabel((current) => current || suggestion);
    setBaseName((current) => (current !== NONE ? current : (bases.find((b) => b.isDefault) ?? bases[0])?.name ?? NONE));
  }, [domains.data, suggestion]);

  const hostname = baseName === NONE ? "" : label.trim() === "@" ? baseName : `${label.trim().toLowerCase()}.${baseName}`;
  const taken = hostname && domains.data?.used.map((d) => d.toLowerCase()).includes(hostname);
  const baseValid = baseName === NONE || (domains.data?.bases ?? []).some((base) => base.name === baseName);
  const canStart = !!target && !target.disabled && !!name.trim() && !starting && !taken && !domains.isLoading && !domains.error && baseValid && (baseName === NONE || !!label.trim());

  async function start() {
    if (!target) return;
    setStarting(true);
    try {
      const run = await api.startMove({ source: sourceRef(source), target: target.ref, projectId, projectName, name: name.trim(), domains: hostname ? [{ domain: hostname }] : [] });
      setMoveId(run.id);
      void queryClient.invalidateQueries({ queryKey: queryKeys.moves });
    } catch (err) { notify.error(err, "Couldn't start the move"); } finally { setStarting(false); }
  }

  return (
    <div className="confirm-backdrop" role="presentation" onMouseDown={() => { if (!moveId && !starting) onClose(); }}>
      <div className="confirm-panel confirm-panel-wide confirm-panel-form" role="dialog" aria-modal="true" aria-label={`Move ${projectName}`} onMouseDown={(event) => event.stopPropagation()}>
        <div className="confirm-copy">
          <div className="flex items-start gap-2">
            <h2 className="flex flex-1 items-center gap-2"><MoveRight size={16} />Move {projectName}{target ? ` to ${target.name}` : ""}</h2>
            <Button type="button" variant="ghost" size="sm" aria-label="Close" onClick={onClose}><X size={14} /></Button>
          </div>
          {moveId && target ? (
            <>
              <p className="mb-3 text-xs text-[var(--dim)]">You can close this: the move keeps running, and you can reopen it from Instances.</p>
              <MoveProgress moveId={moveId} sourceName={sourceName} targetName={target.name} targetPeerId={target.ref.kind === "peer" ? target.ref.peerId : null} />
            </>
          ) : (
            <div className="grid gap-3">
              <p className="text-xs text-[var(--dim)]">
                {projectName} is stopped on {sourceName}, copied with all of its data and secret values to the target, verified byte for byte, and started there. The original is removed only after you confirm; until then you can abort and it comes back as it was. The project is down for the whole copy.
              </p>
              {choices.length === 0 ? <Alert><AlertDescription>There is no other instance to move to. Pair one in Settings &gt; Peers, with the “Move projects” grant.</AlertDescription></Alert> : (
                <>
                  <Field label="Move to" htmlFor="move-target">
                    <AppSelect value={targetValue} onValueChange={setTargetValue} options={choices.map((c) => ({ value: c.value, label: c.label, disabled: c.disabled }))} placeholder="Choose an instance" />
                  </Field>
                  <Field label="Name there" htmlFor="move-name"><Input id="move-name" value={name} onChange={(event) => setName(event.target.value)} /></Field>
                  <Field label="Hostname there" hint={domains.error ? undefined : "Chosen from the domains the target manages. Stackport does not manage DNS: create the record for it before you confirm, and turn on TLS afterwards."} error={domains.error instanceof Error ? domains.error.message : taken ? `${hostname} is already used on ${target?.name}.` : undefined}>
                    {domains.isLoading ? <Loader size={14} className="spin" /> : (
                      <div className="flex gap-2">
                        <Input aria-label="Subdomain" className="w-40 font-mono text-xs" value={label} onChange={(event) => setLabel(event.target.value)} disabled={baseName === NONE} placeholder="label or @" />
                        <AppSelect value={baseName} onValueChange={setBaseName} options={[{ value: NONE, label: "No hostname yet" }, ...(domains.data?.bases ?? []).map((base) => ({ value: base.name, label: `.${base.name}` }))]} />
                      </div>
                    )}
                  </Field>
                  {hostname && <div className="text-xs text-[var(--dim)]">It will be reachable as <span className="mono">{hostname}</span>.</div>}
                </>
              )}
              <div className="confirm-actions">
                <Button type="button" variant="outline" size="sm" onClick={onClose}>Cancel</Button>
                <Button type="button" size="sm" disabled={!canStart} onClick={() => void start()}>{starting && <Loader size={13} className="spin" />}Stop and move</Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
