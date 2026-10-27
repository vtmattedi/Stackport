import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api } from "../api/client";
import { cn } from "../lib/utils";
import type { ComposeIngressTarget } from "../api/types";
import { AppSelect } from "./AppSelect";
import { Button } from "./ui/button";
import styles from "./ProjectIngressSelect.module.scss";

export function ProjectIngressSelect({ projectId, composeFile, value, onValueChange, disabled, refreshKey }: {
  projectId: number;
  composeFile: string | null;
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  refreshKey?: string;
}) {
  const [targets, setTargets] = useState<ComposeIngressTarget[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const changeRef = useRef(onValueChange);
  const valueRef = useRef(value);
  changeRef.current = onValueChange;
  valueRef.current = value;
  useEffect(() => {
    let cancelled = false;
    const previous = valueRef.current;
    setLoading(true);
    setError("");
    setTargets([]);
    changeRef.current("");
    if (!composeFile) {
      setLoading(false);
      setError("Pull or upload the project and select its Compose file first.");
      return;
    }
    api.getProjectIngressTargets(projectId, composeFile).then((found) => {
      if (cancelled) return;
      setTargets(found);
      changeRef.current(found.some(t => `${t.service}:${t.containerPort}` === previous)
        ? previous : found.length === 1 ? `${found[0].service}:${found[0].containerPort}` : "");
    }).catch((err: Error) => {
      if (!cancelled) setError(err.message);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId, composeFile, refreshKey, revision]);
  return (
    <div className={styles.root}>
      <div className={styles.control}>
        <AppSelect value={value} onValueChange={onValueChange}
          disabled={disabled || loading || targets.length === 0}
          placeholder={loading ? "Reading Compose…" : "Select service and port"}
          options={[{ value: "", label: "Select service and port" }, ...targets.map(t => ({value: `${t.service}:${t.containerPort}`, label: `${t.service}:${t.containerPort}`}))]} />
        <Button type="button" size="icon" variant="outline" disabled={disabled || loading} onClick={() => setRevision(r => r + 1)} title="Re-read Compose" aria-label="Refresh service and port options"><RefreshCw size={13} className={loading ? "spin" : undefined} /></Button>
      </div>
      {error && <div className={cn("muted-text", styles.hint)}>{error}</div>}
      {!loading && !error && !targets.length && <div className={cn("muted-text", styles.hint)}>Declare a TCP port with expose in Compose, then refresh.</div>}
    </div>
  );
}
