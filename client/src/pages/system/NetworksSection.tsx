import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Loader, Network, RefreshCw, Trash2 } from "lucide-react";
import { api } from "../../api/client";
import type { DockerNetworkInfo, NetworkOwnerKind, NetworkRemoval } from "../../api/types";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { CheckRow } from "../../components/ui/field";
import { Stack } from "../../components/ui/stack";
import { Hint, Prose } from "../../components/ui/text";
import { SubShellSectionHeader } from "../../components/SubShell";
import { useConfirm } from "../../components/ConfirmDialog";
import { notify } from "../../lib/notify";
import styles from "./NetworksSection.module.scss";

const KIND_LABEL: Record<NetworkOwnerKind, string> = {
  docker: "Docker",
  stackport: "Stackport",
  project: "Project",
  group: "Network group",
  isolated: "Isolated project",
  legacy: "Left by 1.3.0",
  other: "Other",
};

const FILTERS: { value: "all" | NetworkOwnerKind; label: string }[] = [
  { value: "all", label: "All" },
  { value: "project", label: "Projects" },
  { value: "group", label: "Groups" },
  { value: "stackport", label: "Stackport" },
  { value: "other", label: "Other" },
];

function OwnerCell({ network }: { network: DockerNetworkInfo }) {
  const { owner } = network;
  return (
    <div className={styles.owner}>
      <span className={`${styles.kind} ${styles[`kind${owner.kind[0].toUpperCase()}${owner.kind.slice(1)}` as keyof typeof styles] ?? ""}`}>{KIND_LABEL[owner.kind]}</span>
      {owner.projectId !== null
        ? <Link to={`/projects/${owner.projectId}`}>{owner.label}</Link>
        : <span className={styles.muted}>{owner.label}</span>}
    </div>
  );
}

/** The pools as short lines: 15 whole /16 ranges from 172.17.0.0 to 172.31.0.0 are one line, not fifteen. */
function summarizePools(pools: { base: string; size: number }[]): string[] {
  const lines: string[] = [];
  for (let i = 0; i < pools.length;) {
    let j = i;
    while (j + 1 < pools.length && pools[j + 1].size === pools[i].size) j += 1;
    const run = pools.slice(i, j + 1);
    lines.push(run.length === 1
      ? `${run[0].base}, in /${run[0].size} networks`
      : `${run.length} ranges from ${run[0].base} to ${run[run.length - 1].base}, one /${run[0].size} network each`);
    i = j + 1;
  }
  return lines;
}

/** Docker's networks on this host: who owns each, which addresses it takes, and how much of the address pool is left. Read only. */
export function NetworksSection() {
  const { data, error, isFetching, refetch } = useQuery({
    queryKey: ["system", "networks"],
    queryFn: () => api.getNetworks(),
    refetchInterval: 30_000,
    retry: false,
  });
  const [filter, setFilter] = useState<"all" | NetworkOwnerKind>("all");
  const [unusedOnly, setUnusedOnly] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [removing, setRemoving] = useState(false);
  const confirm = useConfirm();

  const header = (
    <SubShellSectionHeader
      title="Networks"
      icon={Network}
      description="Docker's networks on this host, who owns each, and how much of Docker's address pool each takes."
      actions={(
        <Button type="button" variant="outline" size="xs" onClick={() => void refetch()} disabled={isFetching}>
          <RefreshCw size={13} className={isFetching ? "spin" : undefined} />
          Refresh
        </Button>
      )}
    />
  );

  if (error) return <>{header}<Alert variant="destructive"><AlertCircle size={14} /><AlertDescription>{error instanceof Error ? error.message : "Docker could not be read."}</AlertDescription></Alert></>;
  if (!data) return <>{header}<Loader size={14} className="spin" /></>;

  const { networks, headroom } = data;
  const removable = networks.filter((n) => n.removalBlocker === null);
  const shown = networks.filter((n) => (filter === "all" || n.owner.kind === filter) && (!unusedOnly || (n.containers.length === 0 && n.owner.kind !== "docker")));
  const shownRemovable = shown.filter((n) => n.removalBlocker === null);
  // A selection survives a refresh only for networks that are still there and still removable.
  const chosen = removable.filter((n) => selected.has(n.name));

  async function removeChosen() {
    const names = chosen.map((n) => n.name);
    const ok = await confirm({
      title: `Remove ${names.length} ${names.length === 1 ? "network" : "networks"}?`,
      description: `${names.length > 12 ? `${names.slice(0, 12).join(", ")} and ${names.length - 12} more` : names.join(", ")}. Nothing is attached to them. A stopped project's network is made again when it starts, and needs a free slice of the address pool then. Each is checked again just before it is removed.`,
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    setRemoving(true);
    try {
      // The server takes at most 50 names in a call; 1.3.0 left one network per project, so there can be more.
      const results: NetworkRemoval[] = [];
      for (let at = 0; at < names.length; at += 50) results.push(...(await api.removeNetworks(names.slice(at, at + 50))).results);
      const failed = results.filter((r) => !r.removed);
      if (results.length > failed.length) notify.success(`${results.length - failed.length} ${results.length - failed.length === 1 ? "network" : "networks"} removed.`);
      if (failed.length > 0) notify.error(new Error(failed.map((r) => `${r.name}: ${r.reason ?? "not removed"}`).join("; ")), "Some networks were not removed");
      setSelected(new Set());
      await refetch();
    } catch (err) {
      notify.error(err, "Could not remove the networks");
    } finally {
      setRemoving(false);
    }
  }
  const counts = (kind: "all" | NetworkOwnerKind) => (kind === "all" ? networks.length : networks.filter((n) => n.owner.kind === kind).length);
  const percent = headroom.capacity > 0 ? Math.min(100, Math.round((headroom.used / headroom.capacity) * 100)) : 0;
  const fillClass = headroom.level === "critical" ? styles.meterFillCritical : headroom.level === "warning" ? styles.meterFillWarning : "";

  return (
    <>
      {header}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">Address space</div>
        <div className={styles.meter} role="img" aria-label={`${headroom.used} of ${headroom.capacity} address pool slices used`}>
          <div className={`${styles.meterFill} ${fillClass}`} style={{ width: `${percent}%` }} />
        </div>
        <div className={styles.meterText}>
          <span><strong>{headroom.used}</strong> of {headroom.capacity} slices used</span>
          <span><strong>{headroom.free}</strong> {headroom.free === 1 ? "network fits" : "networks fit"} before Docker cannot create another</span>
        </div>
        <ul className={styles.pools} aria-label="Docker's address pools">
          {summarizePools(headroom.pools).map((line) => <li key={line} className="mono">{line}</li>)}
        </ul>
        <Stack gap={2} className="mt-3">
          <Hint>{headroom.poolsKnown ? "The pools Docker hands networks out of." : "Docker's own settings could not be read, so its defaults are assumed."}</Hint>
          {headroom.advice && <Hint>{headroom.advice}</Hint>}
        </Stack>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">Enlarge the address pool</div>
        <Stack gap={3}>
          <Prose>
            Docker's pools hold {headroom.capacity} networks, and every project and network group takes one. Enlarging them is done on the server, because it changes
            Docker's own configuration and needs a Docker restart, which stops every container until it starts again.
          </Prose>
          <code className="mono block w-fit max-w-full overflow-x-auto rounded-md border border-border bg-background px-3 py-2 text-xs">sudo stackport network-pool set --base 10.20.0.0/14 --size 24</code>
          <Hint>
            That makes room for 1024 networks. The command checks the range against the machine's own routes first, backs up <span className="mono">daemon.json</span>, lists the containers that
            will not restart by themselves, asks before restarting Docker, and puts the old file back if Docker does not come up. Networks that exist keep their ranges.
          </Hint>
          <Hint>Run <span className="mono">sudo stackport network-pool</span> with no arguments to see where things stand.</Hint>
        </Stack>
      </div>

      <div className="card">
        <div className="card-title">Networks</div>
        <div className={styles.bar}>
          <div className={styles.filters} role="group" aria-label="Filter by owner">
            {FILTERS.map(({ value, label }) => (
              <button key={value} type="button" className={styles.filter} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label} {counts(value)}</button>
            ))}
          </div>
          <CheckRow className={styles.unused} control={<Checkbox checked={unusedOnly} onCheckedChange={(checked) => setUnusedOnly(checked === true)} />} title="No containers attached" />
        </div>
        {removable.length > 0 && (
          <div className={styles.bar}>
            <Button type="button" variant="outline" size="sm" disabled={removing} onClick={() => setSelected(new Set(shownRemovable.map((n) => n.name)))}>Select the {shownRemovable.length} shown that can be removed</Button>
            <Button type="button" variant="destructive" size="sm" disabled={removing || chosen.length === 0} onClick={() => void removeChosen()}>
              {removing ? <Loader size={13} className="spin" /> : <Trash2 size={13} />} Remove {chosen.length || ""} selected
            </Button>
            <span className={styles.muted}>Only networks with nothing attached can be removed, and never Docker's or Stackport's own.</span>
          </div>
        )}
        {shown.length === 0 ? (
          <div className={styles.empty}>No network matches.</div>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr><th aria-label="Select" />
<th>Name</th><th>Owner</th><th>Subnet</th><th>Slices</th><th>Containers</th></tr></thead>
              <tbody>
                {shown.map((network) => (
                  <tr key={network.id || network.name}>
                    <td>
                      <Checkbox
                        aria-label={`Select ${network.name}`}
                        disabled={network.removalBlocker !== null || removing}
                        title={network.removalBlocker ?? "Nothing is attached: it can be removed"}
                        checked={selected.has(network.name) && network.removalBlocker === null}
                        onCheckedChange={(checked) => setSelected((current) => { const next = new Set(current); if (checked === true) next.add(network.name); else next.delete(network.name); return next; })}
                      />
                    </td>
                    <td className={styles.name}>
                      {network.name}
                      {network.internal && <span className={styles.muted}> (internal)</span>}
                    </td>
                    <td><OwnerCell network={network} /></td>
                    <td className="mono">{network.subnets.length ? network.subnets.join(", ") : <span className={styles.muted}>none</span>}</td>
                    <td>{network.slices || <span className={styles.muted} title="Outside Docker's pools: it costs the pool nothing">0</span>}</td>
                    <td title={network.containers.map((c) => c.name).join(", ") || undefined}>
                      {network.containers.length || <span className={styles.muted}>none</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
