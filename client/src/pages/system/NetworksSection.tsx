import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Loader, Network, RefreshCw, Trash2 } from "lucide-react";
import { api } from "../../api/client";
import type { DockerNetworkInfo, NetworkOwnerKind } from "../../api/types";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
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
  // A selection survives a refresh only for networks that are still there and still removable.
  const chosen = removable.filter((n) => selected.has(n.name));

  async function removeChosen() {
    const names = chosen.map((n) => n.name);
    const ok = await confirm({
      title: `Remove ${names.length} ${names.length === 1 ? "network" : "networks"}?`,
      description: `${names.join(", ")}. Nothing is attached to them. A stopped project's network is made again when it starts, and needs a free slice of the address pool then. Each is checked again just before it is removed.`,
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    setRemoving(true);
    try {
      const { results } = await api.removeNetworks(names);
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
  const shown = networks.filter((n) => (filter === "all" || n.owner.kind === filter) && (!unusedOnly || (n.containers.length === 0 && n.owner.kind !== "docker")));
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
        <p className="hint" style={{ marginTop: 8 }}>
          {headroom.poolsKnown ? "The pools Docker hands networks out of." : "Docker's own settings could not be read, so its defaults are assumed."}
          {headroom.advice ? ` ${headroom.advice}` : ""}
        </p>
      </div>

      <div className="card">
        <div className="card-title">Networks</div>
        <div className={styles.bar}>
          <div className={styles.filters} role="group" aria-label="Filter by owner">
            {FILTERS.map(({ value, label }) => (
              <button key={value} type="button" className={styles.filter} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label} {counts(value)}</button>
            ))}
          </div>
          <label className={styles.unused}>
            <input type="checkbox" checked={unusedOnly} onChange={(e) => setUnusedOnly(e.target.checked)} /> No containers attached
          </label>
        </div>
        {removable.length > 0 && (
          <div className={styles.bar}>
            <Button type="button" variant="outline" size="sm" disabled={removing} onClick={() => setSelected(new Set(removable.map((n) => n.name)))}>Select all {removable.length} that can be removed</Button>
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
                      <input
                        type="checkbox"
                        aria-label={`Select ${network.name}`}
                        disabled={network.removalBlocker !== null || removing}
                        title={network.removalBlocker ?? "Nothing is attached: it can be removed"}
                        checked={selected.has(network.name) && network.removalBlocker === null}
                        onChange={(e) => setSelected((current) => { const next = new Set(current); if (e.target.checked) next.add(network.name); else next.delete(network.name); return next; })}
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
