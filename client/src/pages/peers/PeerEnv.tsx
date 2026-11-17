import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, FileKey, Loader, Plus, Trash2 } from "lucide-react";
import { api } from "../../api/client";
import type { PeerTarget } from "../../api/types";
import { useConfirm } from "../../components/ConfirmDialog";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { notify } from "../../lib/notify";
import { queryKeys } from "../../lib/queryKeys";
import { usePeerCall } from "../../lib/usePeerCall";

interface EnvVariable { key: string; value: string; masked?: boolean }
interface EnvFile { id: number; relativePath: string; variables: EnvVariable[]; unreadable: boolean; updatedAt: string }

/** `touched`: the value field was edited, even to empty. An untouched masked value stays as the peer has it. */
interface Row { key: string; value: string; masked: boolean; existing: boolean; touched: boolean }

const toRows = (variables: EnvVariable[]): Row[] => variables.map((variable) => ({ key: variable.key, value: variable.masked ? "" : variable.value, masked: variable.masked === true, existing: true, touched: false }));

/** What is sent: a masked value the user did not retype stays as the peer has it (`keep`), so a value this instance may not see never has to be sent back. */
const toPayload = (rows: Row[]): unknown[] => rows.filter((row) => row.key.trim()).map((row) => (row.masked && row.existing && !row.touched ? { key: row.key.trim(), keep: true } : { key: row.key.trim(), value: row.value }));

function VariableRows({ rows, setRows, reveal }: { rows: Row[]; setRows: (rows: Row[]) => void; reveal: boolean }) {
  return (
    <div className="grid gap-1.5">
      {rows.map((row, index) => (
        <div key={index} className="flex gap-2">
          <Input value={row.key} onChange={(event) => setRows(rows.map((entry, i) => (i === index ? { ...entry, key: event.target.value } : entry)))} readOnly={row.existing} placeholder="KEY" className="w-56 font-mono text-xs" />
          <Input
            value={row.value}
            onChange={(event) => setRows(rows.map((entry, i) => (i === index ? { ...entry, value: event.target.value, touched: true } : entry)))}
            type={reveal ? "text" : "password"}
            placeholder={row.masked ? "unchanged (hidden)" : "value"}
            autoComplete="off"
            className="min-w-0 flex-1 font-mono text-xs"
          />
          <Button type="button" variant="ghost" size="sm" aria-label={`Remove ${row.key}`} onClick={() => setRows(rows.filter((_, i) => i !== index))}><Trash2 size={13} /></Button>
        </div>
      ))}
      <div><Button type="button" variant="outline" size="sm" onClick={() => setRows([...rows, { key: "", value: "", masked: false, existing: false, touched: false }])}><Plus size={13} />Add variable</Button></div>
    </div>
  );
}

function EnvFileCard({ peer, projectId, file, reveal }: { peer: PeerTarget; projectId: number; file: EnvFile; reveal: boolean }) {
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const call = usePeerCall(peer.id);
  const [rows, setRows] = useState<Row[]>(() => toRows(file.variables));
  const [busy, setBusy] = useState(false);
  const reload = (): void => { void queryClient.invalidateQueries({ queryKey: queryKeys.peerEnv(peer.id, projectId) }); };

  async function save() {
    setBusy(true);
    try {
      await call("PUT", `/projects/${projectId}/env-files/${file.id}`, { relativePath: file.relativePath, variables: toPayload(rows) });
      notify.success(`${file.relativePath} saved on ${peer.name}. It applies at the next deploy.`);
      reload();
    } catch (err) { notify.error(err, `Couldn't save ${file.relativePath} on ${peer.name}`); } finally { setBusy(false); }
  }

  async function remove() {
    const ok = await confirm({ title: `Delete ${file.relativePath} on ${peer.name}?`, description: `The file and its values are removed from ${peer.name}. A project that needs them will fail at its next deploy.`, confirmLabel: "Delete", destructive: true });
    if (!ok) return;
    setBusy(true);
    try { await call("DELETE", `/projects/${projectId}/env-files/${file.id}`); reload(); } catch (err) { notify.error(err, `Couldn't delete ${file.relativePath}`); } finally { setBusy(false); }
  }

  return (
    <div className="border-b border-border py-3 last:border-b-0">
      <div className="mb-2 flex items-center gap-2 text-[13px]"><span className="mono font-medium">{file.relativePath}</span>{file.unreadable && <Badge variant="destructive">Unreadable on the peer</Badge>}</div>
      {file.unreadable ? <div className="text-xs text-[var(--dim)]">{peer.name} cannot read this file's values (its key is not configured, or the data is damaged), so it is not shown or editable.</div> : (
        <>
          <VariableRows rows={rows} setRows={setRows} reveal={reveal} />
          {(
            <div className="mt-3 flex gap-2">
              <Button type="button" size="sm" disabled={busy} onClick={() => void save()}>{busy && <Loader size={13} className="spin" />}Save on {peer.name}</Button>
              <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void remove()}><Trash2 size={13} />Delete file</Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** A project's managed env files on a peer. Values come back masked unless the peer granted secret access; an edit keeps every value you do not retype, on the peer. */
export function PeerEnv({ peer, projectId }: { peer: PeerTarget; projectId: number }) {
  const queryClient = useQueryClient();
  const call = usePeerCall(peer.id);
  const secrets = peer.grants.includes("projects:secrets");
  const [reveal, setReveal] = useState(false);
  const files = useQuery({ queryKey: queryKeys.peerEnv(peer.id, projectId), queryFn: () => api.peerRequest<EnvFile[]>(peer.id, "GET", `/projects/${projectId}/env-files`), retry: false });
  const [path, setPath] = useState(".env");
  const [rows, setRows] = useState<Row[]>([{ key: "", value: "", masked: false, existing: false, touched: false }]);
  const [creating, setCreating] = useState(false);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setCreating(true);
    try {
      await call("POST", `/projects/${projectId}/env-files`, { relativePath: path.trim(), variables: rows.filter((row) => row.key.trim()).map((row) => ({ key: row.key.trim(), value: row.value })) });
      setRows([{ key: "", value: "", masked: false, existing: false, touched: false }]);
      void queryClient.invalidateQueries({ queryKey: queryKeys.peerEnv(peer.id, projectId) });
    } catch (err) { notify.error(err, `Couldn't create the file on ${peer.name}`); } finally { setCreating(false); }
  }

  return (
    <div className="card">
      <div className="card-title flex items-center gap-2">
        <FileKey size={13} />Environment on {peer.name}
        <span className="ml-auto flex items-center gap-2 font-normal normal-case">
          {secrets ? <Badge variant="secondary">Values visible</Badge> : <Badge variant="outline">Values hidden</Badge>}
          {secrets && <Button type="button" variant="ghost" size="sm" onClick={() => setReveal((v) => !v)}>{reveal ? <EyeOff size={13} /> : <Eye size={13} />}{reveal ? "Hide" : "Show"}</Button>}
        </span>
      </div>
      <p className="mb-3 text-xs text-[var(--dim)]">
        {secrets ? `This instance may read ${peer.name}'s secret values. They are shown from ${peer.name} now and are not stored here.` : `${peer.name} keeps the values. You can set or replace one, and leave the rest as they are.`}
      </p>
      {files.isLoading ? <Loader size={14} className="spin" /> : files.error ? <Alert variant="destructive"><AlertDescription>{files.error instanceof Error ? files.error.message : "Couldn't read the env files."}</AlertDescription></Alert> : (
        <>
          {(files.data ?? []).length === 0 && <div className="py-2 text-[13px] text-[var(--dim)]">No env files yet.</div>}
          {(files.data ?? []).map((file) => <EnvFileCard key={`${file.id}:${file.updatedAt}`} peer={peer} projectId={projectId} file={file} reveal={reveal} />)}
        </>
      )}
      {(
        <form className="mt-4 grid gap-2 border-t border-border pt-4" onSubmit={(event) => void create(event)}>
          <div className="text-xs font-medium text-[var(--dim)]">New env file</div>
          <Input value={path} onChange={(event) => setPath(event.target.value)} className="max-w-xs font-mono text-xs" aria-label="Path" required />
          <VariableRows rows={rows} setRows={setRows} reveal={reveal || !secrets} />
          <div><Button type="submit" size="sm" disabled={creating || !path.trim()}>{creating ? <Loader size={13} className="spin" /> : <Plus size={13} />}Create on {peer.name}</Button></div>
        </form>
      )}
    </div>
  );
}
