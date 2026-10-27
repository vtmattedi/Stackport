import { useEffect, useState } from "react";
import { AlertCircle, Loader, Save, Trash2, X } from "lucide-react";
import { api } from "../../api/client";
import type { DockerStorageThresholds } from "../../api/types";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { NumberInput } from "../../components/NumberInput";
import { ServiceError } from "../../components/ServiceError";
import { useSystem } from "../../context/SystemContext";
import { cn } from "../../lib/utils";
import { notify } from "../../lib/notify";
import styles from "./StorageSection.module.scss";

const GB = 1024 * 1024 * 1024;

function formatBytes(bytes: number | null): string {
  if (bytes == null) return "unknown";
  const gb = bytes / GB;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

function OutputBlock({ output, ok, onDismiss }: { output: string; ok: boolean; onDismiss: () => void }) {
  return (
    <div className={styles.outputShell}>
      <Button type="button" variant="ghost" size="icon-xs" className={styles.outputDismiss} onClick={onDismiss} title="Dismiss">
        <X size={12} />
      </Button>
      <pre className={cn("output-block", styles.outputBlock, !ok && "output-stderr")}>
        {output || "(no output)"}
      </pre>
    </div>
  );
}

/** Docker disk usage, build-cache pruning and the free-space thresholds that gate builds. */
export default function StorageSection() {
  const { system, refreshSystem: refresh, pruneDockerCache } = useSystem();
  const [pruningDocker, setPruningDocker] = useState(false);
  const [dockerPruneResult, setDockerPruneResult] = useState<{ ok: boolean; output: string } | null>(null);
  const [storageThresholdsDraft, setStorageThresholdsDraft] = useState<DockerStorageThresholds | null>(null);
  const [storageThresholdsDirty, setStorageThresholdsDirty] = useState(false);
  const [savingStorageThresholds, setSavingStorageThresholds] = useState(false);

  const docker = system?.docker;
  const dockerDiskUsage = docker?.diskUsage ?? [];
  const dockerStorage = docker?.storage ?? null;

  useEffect(() => {
    api.getDockerStorageThresholds()
      .then((result) => setStorageThresholdsDraft(result))
      .catch(() => {});
  }, []);

  async function handleDockerPrune() {
    setPruningDocker(true);
    setDockerPruneResult(null);
    try {
      const final = await pruneDockerCache();
      setDockerPruneResult(final ? { ok: final.ok ?? false, output: final.log } : { ok: false, output: "Prune failed" });
      refresh();
    } finally {
      setPruningDocker(false);
    }
  }

  async function handleStorageThresholdsSave() {
    if (!storageThresholdsDraft) return;
    setSavingStorageThresholds(true);
    try {
      const result = await api.updateDockerStorageThresholds(storageThresholdsDraft);
      setStorageThresholdsDraft(result);
      setStorageThresholdsDirty(false);
      notify.success("Storage thresholds updated");
    } catch (err) {
      notify.error(err, "Failed to update storage thresholds");
    } finally {
      setSavingStorageThresholds(false);
    }
  }

  if (system && !docker?.available) {
    return <ServiceError service="Docker" reason={docker?.reason} className={styles.softAlert} />;
  }

  return (
    <div className="section-stack">
      <div className={styles.panel}>
        <div className={styles.panelTitle}>
          <span>Disk usage</span>
          <div className={cn("row-actions", styles.titleActions)}>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => void handleDockerPrune()}
              disabled={pruningDocker}
              title="docker builder prune -a -f"
            >
              {pruningDocker ? <Loader size={12} className="spin" /> : <Trash2 size={12} />}
              Prune build cache
            </Button>
          </div>
        </div>
        <div className={styles.body}>
          {dockerDiskUsage.length === 0 ? (
            <div className={styles.empty}>No disk usage data.</div>
          ) : (
            <div className={styles.dfList}>
              <div className={cn(styles.dfRow, styles.dfHead)}>
                <span>Type</span>
                <span>Count (active)</span>
                <span>Size</span>
                <span>Reclaimable</span>
              </div>
              {dockerDiskUsage.map((entry) => (
                <div key={entry.type} className={styles.dfRow}>
                  <span>{entry.type}</span>
                  <span>{entry.totalCount} ({entry.active})</span>
                  <span className="mono">{entry.size}</span>
                  <span className="mono">{entry.reclaimable}</span>
                </div>
              ))}
            </div>
          )}
          {dockerPruneResult && (
            <OutputBlock
              output={dockerPruneResult.output}
              ok={dockerPruneResult.ok}
              onDismiss={() => setDockerPruneResult(null)}
            />
          )}
        </div>
      </div>

      {dockerStorage && (
        <div className={styles.panel}>
          <div className={styles.panelTitle}>
            <span>Storage pressure</span>
          </div>
          {dockerStorage.state !== "unknown" && (
            <div className="muted-text" style={{ marginBottom: 8 }}>
              {formatBytes(dockerStorage.freeBytes)} free
              {dockerStorage.totalBytes != null && ` of ${formatBytes(dockerStorage.totalBytes)}`}
              {" — "}
              <strong
                style={{
                  color: dockerStorage.state === "critical"
                    ? "var(--danger)"
                    : dockerStorage.state === "warning"
                      ? "var(--brand)"
                      : undefined,
                }}
              >
                {dockerStorage.state}
              </strong>
            </div>
          )}
          {dockerStorage.state === "critical" && (
            <Alert className={styles.softAlert}>
              <AlertCircle size={14} />
              <AlertDescription>
                New builds are blocked until space is freed — an automatic build-cache cleanup runs first, and
                the build only proceeds if that frees up enough room.
              </AlertDescription>
            </Alert>
          )}
          {storageThresholdsDraft && (
            <div className="row-actions" style={{ alignItems: "flex-end", flexWrap: "wrap", gap: 12, marginTop: 8 }}>
              <div className="field" style={{ maxWidth: 160 }}>
                <label>Warning below</label>
                <NumberInput
                  min={0}
                  step={0.5}
                  suffix="GB"
                  value={storageThresholdsDraft.warningFreeBytes / GB}
                  onValueChange={(gb) => {
                    setStorageThresholdsDraft({ ...storageThresholdsDraft, warningFreeBytes: Math.round((gb ?? 0) * GB) });
                    setStorageThresholdsDirty(true);
                  }}
                />
                <span className="hint">GB free</span>
              </div>
              <div className="field" style={{ maxWidth: 160 }}>
                <label>Critical below</label>
                <NumberInput
                  min={0}
                  step={0.5}
                  suffix="GB"
                  value={storageThresholdsDraft.criticalFreeBytes / GB}
                  onValueChange={(gb) => {
                    setStorageThresholdsDraft({ ...storageThresholdsDraft, criticalFreeBytes: Math.round((gb ?? 0) * GB) });
                    setStorageThresholdsDirty(true);
                  }}
                />
                <span className="hint">GB free</span>
              </div>
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => void handleStorageThresholdsSave()}
                disabled={savingStorageThresholds || !storageThresholdsDirty}
              >
                {savingStorageThresholds ? <Loader size={12} className="spin" /> : <Save size={12} />}
                Save
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
