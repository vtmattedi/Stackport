import { useCallback, useEffect, useState } from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, Info, Loader, Play, Search } from "lucide-react";
import { ApiError } from "../../../api/client";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { useConfirm } from "../../../components/ConfirmDialog";
import { notify } from "../../../lib/notify";
import { migrationsApi, type MigrationInfo, type MigrationMode, type ReportStatus } from "./migrationsApi";
import styles from "./MigrationsSection.module.scss";

const STATUS_ICON: Record<ReportStatus, typeof Info> = { ok: CheckCircle2, warn: AlertTriangle, error: AlertCircle, info: Info };

/** TEMPORARY: one-off migrations with a dry run and an execute. Delete this folder when
 *  every install has run them (see src/modules/maintenance/migrations/types.ts on the server). */
export default function MigrationsSection() {
  const confirmDialog = useConfirm();
  const [migrations, setMigrations] = useState<MigrationInfo[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setMigrations(await migrationsApi.list());
      setError("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load migrations");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const anyRunning = migrations?.some((m) => m.job.state === "running") ?? false;
  useEffect(() => {
    if (!anyRunning) return;
    const timer = window.setInterval(() => { void load(); }, 2000);
    return () => window.clearInterval(timer);
  }, [anyRunning, load]);

  async function start(migration: MigrationInfo, mode: MigrationMode) {
    if (mode === "execute") {
      const ok = await confirmDialog({
        title: `Execute "${migration.title}"?`,
        description: migration.executeWarning,
        confirmLabel: "Execute",
        destructive: migration.destructive,
      });
      if (!ok) return;
    }
    try {
      await migrationsApi.start(migration.id, mode);
      await load();
    } catch (err) {
      notify.error(err, mode === "dry-run" ? "Could not start the dry run" : "Could not start the migration");
    }
  }

  if (error) return <Alert variant="destructive"><AlertCircle size={14} /><AlertDescription>{error}</AlertDescription></Alert>;
  if (!migrations) return <div className={styles.empty}><Loader size={14} className="spin" /> Loading…</div>;
  if (!migrations.length) return <div className={styles.empty}>No migrations are pending.</div>;

  return (
    <div className={styles.list}>
      <Alert>
        <Info size={14} />
        <AlertDescription>
          Temporary page for one-off data migrations. A dry run shows what would happen and changes nothing.
        </AlertDescription>
      </Alert>
      {migrations.map((migration) => {
        const { job } = migration;
        const running = job.state === "running";
        return (
          <section key={migration.id} className={styles.card}>
            <header className={styles.header}>
              <h3>{migration.title}</h3>
              <div className={styles.actions}>
                <Button type="button" variant="outline" size="sm" disabled={running} onClick={() => void start(migration, "dry-run")}>
                  {running && job.mode === "dry-run" ? <Loader size={14} className="spin" /> : <Search size={14} />} Dry run
                </Button>
                <Button type="button" size="sm" disabled={running} onClick={() => void start(migration, "execute")}>
                  {running && job.mode === "execute" ? <Loader size={14} className="spin" /> : <Play size={14} />} Execute
                </Button>
              </div>
            </header>
            <p className={styles.description}>{migration.description}</p>

            {running && <p className={styles.status}>Running {job.mode === "execute" ? "migration" : "dry run"}…</p>}
            {job.state === "failed" && (
              <Alert variant="destructive"><AlertCircle size={14} /><AlertDescription>{job.error ?? "The run failed."}</AlertDescription></Alert>
            )}
            {job.report && !running && (
              <div className={styles.report}>
                <p className={styles.summary}>
                  {job.mode === "dry-run" ? "Dry run: " : "Executed: "}{job.report.summary}
                  {job.finishedAt && <span className={styles.time}> {new Date(job.finishedAt).toLocaleString()}</span>}
                </p>
                <ul>
                  {job.report.items.map((item, index) => {
                    const Icon = STATUS_ICON[item.status];
                    return (
                      <li key={index} className={styles[item.status]}>
                        <Icon size={14} />
                        <div>
                          <strong>{item.label}</strong>
                          {item.detail && <span>{item.detail}</span>}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
