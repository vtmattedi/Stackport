import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Loader, Network, RefreshCw } from "lucide-react";
import { api } from "../../api/client";
import type { DockerNetworkInfo, NetworkOwnerKind } from "../../api/types";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { SubShellSectionHeader } from "../../components/SubShell";
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
        {shown.length === 0 ? (
          <div className={styles.empty}>No network matches.</div>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr><th>Name</th><th>Owner</th><th>Subnet</th><th>Slices</th><th>Containers</th></tr></thead>
              <tbody>
                {shown.map((network) => (
                  <tr key={network.id || network.name}>
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
