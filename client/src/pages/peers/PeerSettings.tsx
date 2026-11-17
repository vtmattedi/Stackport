import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader } from "lucide-react";
import type { DeployTrigger, PeerTarget, RemoteProjectDetail } from "../../api/types";
import { AppSelect } from "../../components/AppSelect";
import { Button } from "../../components/ui/button";
import { Field } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { Stack } from "../../components/ui/stack";
import { notify } from "../../lib/notify";
import { usePeerCall } from "../../lib/usePeerCall";
import { queryKeys } from "../../lib/queryKeys";

const TRIGGERS: { value: DeployTrigger; label: string }[] = [
  { value: "manual", label: "Manual only" },
  { value: "poller", label: "GitHub poller" },
  { value: "webhook", label: "GitHub webhook" },
];

/** A project's configuration on a peer. Each field is saved by the peer through its own project update, so its validation is the peer's. */
export function PeerSettings({ peer, project }: { peer: PeerTarget; project: RemoteProjectDetail }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(project.name);
  const [group, setGroup] = useState(project.group ?? "");
  const [branch, setBranch] = useState(project.branch ?? "");
  const [endpoint, setEndpoint] = useState(project.healthCheck.endpoint ?? "");
  const [interval, setIntervalS] = useState(String(project.healthCheck.intervalS));
  const [trigger, setTrigger] = useState(project.deployTrigger);
  const [saving, setSaving] = useState(false);
  const canWrite = peer.grants.includes("projects:write");
  const call = usePeerCall(peer.id);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    let saved = false;
    try {
      await call("PATCH", `/projects/${project.id}`, {
        name: name.trim(),
        groupName: group.trim() || null,
        autoDeployBranch: branch.trim() || null,
        healthCheckEndpoint: endpoint.trim() || null,
        healthCheckIntervalS: Number(interval),
      });
      saved = true;
      if (trigger !== project.deployTrigger) await call("PUT", `/projects/${project.id}/deploy-trigger`, { trigger });
      notify.success(`Saved on ${peer.name}.`);
    } catch (err) {
      // The two changes are separate requests: say which one went through, so the form is not mistaken for the peer's state.
      notify.error(err, saved ? `Saved on ${peer.name}, except the deploy trigger` : `Couldn't save on ${peer.name}`);
    } finally {
      setSaving(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.peerProject(peer.id, project.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.peerProjects(peer.id) });
    }
  }

  return (
    <form className="card" onSubmit={(event) => void save(event)}>
      <Stack gap={4}>
        <div className="flex flex-wrap gap-3">
          <Field label="Name" htmlFor="peer-project-name" className="min-w-[220px] flex-1 basis-60"><Input id="peer-project-name" value={name} onChange={(event) => setName(event.target.value)} required disabled={!canWrite} /></Field>
          <Field label="Group" htmlFor="peer-project-group" optional className="min-w-[180px] flex-1 basis-48"><Input id="peer-project-group" value={group} onChange={(event) => setGroup(event.target.value)} disabled={!canWrite} /></Field>
        </div>
        <div className="flex flex-wrap gap-3">
          <Field label="Branch to deploy" htmlFor="peer-project-branch" optional className="min-w-[180px] flex-1 basis-48"><Input id="peer-project-branch" value={branch} onChange={(event) => setBranch(event.target.value)} className="font-mono text-xs" disabled={!canWrite} /></Field>
          <Field label="Deploy trigger" className="w-52 flex-none"><AppSelect value={trigger} onValueChange={setTrigger} options={TRIGGERS} disabled={!canWrite} /></Field>
        </div>
        <div className="flex flex-wrap gap-3">
          <Field label="Health check path" htmlFor="peer-project-health" optional className="min-w-[180px] flex-1 basis-48" hint="For example /health. Empty turns the check off."><Input id="peer-project-health" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} className="font-mono text-xs" disabled={!canWrite} /></Field>
          <Field label="Every (seconds)" htmlFor="peer-project-interval" className="w-40 flex-none"><Input id="peer-project-interval" type="number" min={0} value={interval} onChange={(event) => setIntervalS(event.target.value)} disabled={!canWrite} /></Field>
        </div>
        {canWrite && <div><Button type="submit" disabled={saving || !name.trim()}>{saving && <Loader size={13} className="spin" />}Save on {peer.name}</Button></div>}
      </Stack>
    </form>
  );
}
