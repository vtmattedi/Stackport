import { useCallback, useEffect, useRef, useState } from "react";
import { Archive, CheckCircle2, Download, Loader, Trash2, TriangleAlert, Upload } from "lucide-react";
import { api, sessionHeaders } from "../../api/client";
import type { FullBackupView, RestorePreview, RestoreStatus } from "../../api/types";
import { AppSelect } from "../../components/AppSelect";
import { useConfirm } from "../../components/ConfirmDialog";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Field } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { Stack } from "../../components/ui/stack";
import { Hint, Prose } from "../../components/ui/text";
import { notify } from "../../lib/notify";

const bytes = (n: number): string => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Uploads with progress: a full backup can be gigabytes, so it goes as one streamed request rather than through memory. */
function upload(file: File, onProgress: (sent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", "/api/backup/restore/upload");
    for (const [name, value] of Object.entries(sessionHeaders())) request.setRequestHeader(name, value);
    request.setRequestHeader("Content-Type", "application/octet-stream");
    request.upload.onprogress = (event) => onProgress(event.loaded);
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) { resolve(); return; }
      let message = request.status === 413
        ? "The server rejected the backup as too large. Update Stackport on this destination; if it is already updated, check the upload limit of any proxy in front of it."
        : "The upload failed";
      try { message = (JSON.parse(request.responseText) as { error?: string }).error ?? message; } catch { /* keep */ }
      reject(new Error(message));
    };
    request.onerror = () => reject(new Error("The upload was interrupted"));
    request.send(file);
  });
}

function FullBackupCard() {
  const confirm = useConfirm();
  const [backups, setBackups] = useState<FullBackupView[]>([]);
  const [passphrase, setPassphrase] = useState("");
  const [repeat, setRepeat] = useState("");
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => { try { setBackups((await api.getFullBackups()).backups); } catch { /* shown on the next poll */ } }, []);
  useEffect(() => { void load(); }, [load]);
  const running = backups.some((b) => b.state === "running");
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => { void load(); }, 2000);
    return () => window.clearInterval(timer);
  }, [running, load]);

  async function start(event: React.FormEvent) {
    event.preventDefault();
    setStarting(true);
    try { await api.startFullBackup(passphrase); setPassphrase(""); setRepeat(""); await load(); } catch (err) { notify.error(err, "Couldn't start the backup"); } finally { setStarting(false); }
  }
  async function remove(id: string) {
    if (!(await confirm({ title: "Delete this backup?", description: "The file is removed from this instance. A copy you downloaded is not affected.", confirmLabel: "Delete", destructive: true }))) return;
    try { await api.deleteFullBackup(id); await load(); } catch (err) { notify.error(err, "Couldn't delete the backup"); }
  }

  return (
    <div className="card mb-0!">
      <div className="card-title"><Archive size={13} />Full backup</div>
      <Stack gap={4}>
        <Prose>
          This instance's settings and secrets, and every project with its data, in one encrypted file. Restore it on another Stackport from its Settings &gt; Backup, and that instance becomes a copy of this one.
          Each running project is stopped while its own data is copied, and started again; the others are not touched.
        </Prose>
        <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => void start(event)}>
          <Field label="Passphrase" htmlFor="full-pass" hint="At least 12 characters. Without it the file cannot be opened, and there is no recovery.">
            <Input id="full-pass" type="password" autoComplete="new-password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} />
          </Field>
          <Field label="Repeat it" htmlFor="full-pass2"><Input id="full-pass2" type="password" autoComplete="new-password" value={repeat} onChange={(event) => setRepeat(event.target.value)} /></Field>
          <Button type="submit" disabled={starting || running || passphrase.length < 12 || passphrase !== repeat}>{(starting || running) && <Loader size={13} className="spin" />}Create full backup</Button>
        </form>
        {backups.length === 0 ? <Hint>No backup has been made from here yet.</Hint> : (
          <ul className="grid gap-3">
            {backups.map((backup) => (
              <li key={backup.id} className="rounded border border-[var(--border)] p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-medium">{new Date(backup.createdAt).toLocaleString()}</span>
                  <span className="text-[var(--dim)]">{backup.state === "running" ? "running" : backup.state === "done" ? `ready${backup.size ? `, ${bytes(backup.size)}` : ""}` : "failed"}</span>
                  <span className="flex-1" />
                  {backup.state === "done" && backup.file && <a className="btn btn-outline btn-sm inline-flex items-center gap-1" href={api.fullBackupDownloadUrl(backup.id)} download><Download size={13} />Download</a>}
                  {backup.state !== "running" && <Button type="button" variant="ghost" size="sm" aria-label="Delete this backup" onClick={() => void remove(backup.id)}><Trash2 size={13} /></Button>}
                </div>
                {backup.error && <Alert variant="destructive" className="mt-2"><TriangleAlert size={14} /><AlertDescription>{backup.error}</AlertDescription></Alert>}
                <ol className="mt-2 list-decimal pl-5 text-xs text-[var(--dim)]">{backup.steps.map((step, index) => <li key={index}>{step.text}</li>)}</ol>
              </li>
            ))}
          </ul>
        )}
      </Stack>
    </div>
  );
}

function RestoreCard() {
  const confirm = useConfirm();
  const [status, setStatus] = useState<RestoreStatus | null>(null);
  const [offline, setOffline] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [sent, setSent] = useState<number | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [mode, setMode] = useState<"recover" | "clone">("recover");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try { setStatus(await api.getRestoreStatus()); setOffline(false); } catch { setOffline(true); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // While this instance is being replaced it stops answering, then comes back as the restored one: keep asking.
  const waiting = !!status?.plan && (status.host.state === "running" || status.finish?.running === true || offline);
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => { void load(); }, 3000);
    return () => window.clearInterval(timer);
  }, [waiting, load]);

  async function send() {
    if (!file) return;
    setBusy(true);
    setSent(0);
    try {
      await upload(file, setSent);
      setPreview(await api.inspectRestore(passphrase));
      await load();
    } catch (err) { notify.error(err, "Couldn't read the backup"); setSent(null); } finally { setBusy(false); }
  }
  async function replace() {
    if (!preview) return;
    if (!(await confirm({ title: `Replace ${preview.confirmName}?`, description: `This instance's settings, secrets and password are replaced by ${preview.source.instance.name}'s, and its ${preview.projects.length} project${preview.projects.length === 1 ? "" : "s"} are brought back. Stackport restarts. The current database is kept on the host.`, confirmLabel: "Replace this instance", destructive: true }))) return;
    setBusy(true);
    try { await api.confirmRestore({ passphrase, mode, confirm: typed }); setPreview(null); await load(); } catch (err) { notify.error(err, "Couldn't start the restore"); } finally { setBusy(false); }
  }
  async function bringBack() {
    setBusy(true);
    try { await api.finishRestoreProjects(passphrase); await load(); } catch (err) { notify.error(err, "Couldn't restore the projects"); } finally { setBusy(false); }
  }
  async function cancel() {
    if (!(await confirm({ title: "Cancel this restore?", description: "The uploaded backup is removed from this instance.", confirmLabel: "Cancel restore", destructive: true }))) return;
    try { await api.cancelRestore(); setPreview(null); setSent(null); setFile(null); setPassphrase(""); await load(); } catch (err) { notify.error(err, "Couldn't cancel"); }
  }

  const plan = status?.plan ?? null;
  const finish = status?.finish ?? null;
  const hostDone = !!plan && !offline && status?.host.state !== "running" && status?.host.state !== "failed";
  const hostFailed = status?.host.state === "failed";

  return (
    <div className="card mb-0!">
      <div className="card-title"><Upload size={13} />Restore a full backup here</div>
      <Stack gap={4}>
        {!plan && !finish ? (
          <>
            <Prose>Upload a full backup made on another Stackport. You see what it holds and what will be replaced before anything changes. Restoring replaces <strong>this</strong> instance: its settings, secrets and administrator password become the backup's.</Prose>
            {!preview && !status?.preview && (
              <div className="flex flex-wrap items-end gap-3">
                <Field label="Backup file" htmlFor="restore-file">
                  <input id="restore-file" ref={input} type="file" accept=".spbackup" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
                </Field>
                <Field label="Passphrase" htmlFor="restore-pass"><Input id="restore-pass" type="password" autoComplete="off" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} /></Field>
                <Button type="button" disabled={busy || !file || !passphrase} onClick={() => void send()}>{busy && <Loader size={13} className="spin" />}Upload and check</Button>
                {sent !== null && file && <Hint>{bytes(sent)} of {bytes(file.size)}{sent >= file.size ? " — checking it, this takes a while for a large backup" : ""}</Hint>}
              </div>
            )}
            {!preview && status?.preview && (
              <Alert><AlertDescription>A backup was uploaded and checked earlier. Enter its passphrase to see it again, or cancel it.
                <div className="mt-2 flex gap-2"><Input type="password" aria-label="Passphrase" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} className="w-64" />
                  <Button type="button" size="sm" disabled={busy || !passphrase} onClick={() => void (async () => { setBusy(true); try { setPreview(await api.inspectRestore(passphrase)); } catch (err) { notify.error(err, "Couldn't read the backup"); } finally { setBusy(false); } })()}>Show it</Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => void cancel()}>Cancel</Button></div></AlertDescription></Alert>
            )}
            {preview && (
              <Stack gap={3}>
                <div className="text-sm">
                  From <strong>{preview.source.instance.name}</strong>, made {new Date(preview.source.createdAt).toLocaleString()} (Stackport {preview.source.stackportVersion}).
                </div>
                {preview.findings.map((finding, index) => <Alert key={index} variant={finding.level === "error" ? "destructive" : "default"}><TriangleAlert size={14} /><AlertDescription>{finding.message}</AlertDescription></Alert>)}
                <div>
                  <div className="mb-1 text-xs font-medium">{preview.projects.length} project{preview.projects.length === 1 ? "" : "s"} to bring back</div>
                  <ul className="text-xs text-[var(--dim)]">
                    {preview.projects.map((project) => <li key={project.id}>{project.name} — {bytes(project.size)}{project.hostnames.length ? `, ${project.hostnames.join(", ")}` : ""}{project.wasRunning ? ", was running" : ", was stopped"}</li>)}
                  </ul>
                </div>
                <Alert><TriangleAlert size={14} /><AlertDescription>
                  This instance ({preview.current.name ?? "unnamed"}) has {preview.current.projects} project{preview.current.projects === 1 ? "" : "s"}. <strong>Its settings, secrets and administrator password are replaced</strong>, and its projects are not carried over: the backup's projects are brought back instead. The current database is kept on the host (under backups/pre-restore-…). Not in the backup: {preview.notCarried.join("; ")}.
                </AlertDescription></Alert>
                <div className="flex flex-wrap items-end gap-3">
                  <Field label="Restore as" htmlFor="restore-mode" hint={mode === "recover" ? "The same instance on a new host: keeps its identity, and starts the projects that were running." : "A new instance: new identity, automation off, projects stay paused."}>
                    <AppSelect value={mode} onValueChange={(value) => setMode(value as "recover" | "clone")} options={[{ value: "recover", label: "Recover (same instance, new host)" }, { value: "clone", label: "Clone (new instance)" }]} />
                  </Field>
                  <Field label={`Type ${preview.confirmName} to confirm`} htmlFor="restore-confirm"><Input id="restore-confirm" value={typed} onChange={(event) => setTyped(event.target.value)} /></Field>
                  <Field label="Passphrase again" htmlFor="restore-pass2"><Input id="restore-pass2" type="password" autoComplete="off" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} /></Field>
                  <Button type="button" variant="destructive" disabled={busy || typed !== preview.confirmName || !passphrase} onClick={() => void replace()}>{busy && <Loader size={13} className="spin" />}Replace this instance</Button>
                  <Button type="button" variant="outline" onClick={() => void cancel()}>Cancel</Button>
                </div>
              </Stack>
            )}
          </>
        ) : (
          <Stack gap={3}>
            <div className="text-sm">{plan ? <>Restoring <strong>{plan.source.name}</strong> ({plan.mode}).</> : "The projects of the restored backup."}</div>
            {status?.host.state === "running" || offline ? (
              <Alert><Loader size={14} className="spin" /><AlertDescription>Replacing this instance. Stackport stops and starts again, and the page reconnects by itself; you will sign in with the backup's administrator password.</AlertDescription></Alert>
            ) : hostFailed ? (
              <Alert variant="destructive"><TriangleAlert size={14} /><AlertDescription>The host restore failed; this instance is unchanged.<pre className="mt-2 max-h-60 overflow-auto text-xs">{status?.host.output}</pre>
                <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => void cancel()}>Discard the backup</Button></AlertDescription></Alert>
            ) : null}
            {plan && hostDone && !finish?.running && (
              <div className="flex flex-wrap items-end gap-3">
                <Alert><CheckCircle2 size={14} /><AlertDescription>{finish ? "Some projects or routes need another attempt. Verified imports are kept, and completed projects are skipped." : <>The instance is restored. Its {plan.projects.length} project{plan.projects.length === 1 ? "" : "s"} still need to be brought back; their data is read from the uploaded backup, which needs the passphrase once more.</>}</AlertDescription></Alert>
                <Field label="Passphrase" htmlFor="finish-pass"><Input id="finish-pass" type="password" autoComplete="off" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} /></Field>
                <Button type="button" disabled={busy || !passphrase} onClick={() => void bringBack()}>{busy && <Loader size={13} className="spin" />}Bring the projects back</Button>
                <Button type="button" variant="outline" onClick={() => void cancel()}>Skip the projects</Button>
              </div>
            )}
            {finish && (
              <ul className="grid gap-2 text-sm">
                {finish.outcomes.map((outcome) => (
                  <li key={outcome.id} className="flex flex-wrap items-center gap-2">
                    {outcome.state === "done" ? <CheckCircle2 size={14} /> : outcome.state === "failed" ? <TriangleAlert size={14} /> : <Loader size={14} className={outcome.state === "waiting" ? "" : "spin"} />}
                    <span className="font-medium">{outcome.name}</span><span className="text-xs text-[var(--dim)]">{outcome.state}</span>
                    {outcome.message && <span className="text-xs text-[var(--dim)]">{outcome.message}</span>}
                  </li>
                ))}
                {finish.finished && finish.outcomes.some((o) => o.state === "failed") && <Hint>A project that failed keeps its backup here: fix the cause and bring the projects back again.</Hint>}
              </ul>
            )}
          </Stack>
        )}
      </Stack>
    </div>
  );
}

/** Settings > Backup: a full backup of this instance to download, and a full restore from one. */
export default function BackupSection() {
  return (
    <Stack gap={4}>
      <FullBackupCard />
      <RestoreCard />
    </Stack>
  );
}
