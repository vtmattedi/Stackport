import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader, Plus } from "lucide-react";
import { api } from "../../api/client";
import type { Credential } from "../../api/types";
import { AppSelect } from "../../components/AppSelect";
import { PeerBanner } from "../../components/PeerBanner";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Field } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { Stack } from "../../components/ui/stack";
import { notify } from "../../lib/notify";
import { queryKeys } from "../../lib/queryKeys";
import { usePeerCall } from "../../lib/usePeerCall";
import { usePeer } from "./PeerLayout";

const NO_CREDENTIAL = "";

/** Creates a project on a peer from a GitHub repository. The peer creates and owns it; this instance keeps nothing but what it shows. Uploading source files needs a larger channel than this one and is not offered here yet. */
export default function NewPeerProject() {
  const peer = usePeer();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canWrite = peer.grants.includes("projects:write");
  const call = usePeerCall(peer.id);
  const credentials = useQuery({ queryKey: ["peers", peer.id, "credentials"], queryFn: () => api.peerRequest<Credential[]>(peer.id, "GET", "/credentials"), enabled: canWrite, retry: false });
  const [name, setName] = useState("");
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("main");
  const [credentialId, setCredentialId] = useState(NO_CREDENTIAL);
  const [creating, setCreating] = useState(false);
  const githubCredentials = (credentials.data ?? []).filter((credential) => credential.type === "github");

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setCreating(true);
    try {
      const project = await call<{ id: number }>("POST", "/projects", {
        name: name.trim(),
        sourceType: "github",
        githubRepo: repo.trim(),
        autoDeployBranch: branch.trim() || null,
        ...(credentialId ? { githubCredentialId: Number(credentialId) } : {}),
      });
      notify.success(`Created on ${peer.name}. Deploy it from its page.`);
      void queryClient.invalidateQueries({ queryKey: queryKeys.peerProjects(peer.id) });
      navigate(`/peers/${peer.id}/projects/${project.id}`);
    } catch (err) {
      notify.error(err, `Couldn't create the project on ${peer.name}`);
    } finally {
      setCreating(false);
    }
  }

  return (
    <main className="main">
      <PeerBanner peer={peer} />
      <h1 className="page-title mb-4">New project on {peer.name}</h1>
      {!canWrite ? (
        <Alert><AlertDescription>{peer.name} did not grant this instance permission to create or change projects.</AlertDescription></Alert>
      ) : (
        <form className="card" onSubmit={(event) => void create(event)}>
          <Stack gap={4}>
            <div className="flex flex-wrap gap-3">
              <Field label="Name" htmlFor="new-peer-name" className="min-w-[220px] flex-1 basis-60"><Input id="new-peer-name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={80} /></Field>
              <Field label="Branch" htmlFor="new-peer-branch" className="w-48 flex-none"><Input id="new-peer-branch" value={branch} onChange={(event) => setBranch(event.target.value)} className="font-mono text-xs" /></Field>
            </div>
            <Field label="Repository" htmlFor="new-peer-repo" hint="owner/name on GitHub."><Input id="new-peer-repo" value={repo} onChange={(event) => setRepo(event.target.value)} placeholder="acme/shop" className="font-mono text-xs" required /></Field>
            <Field label="GitHub credential" optional hint={`One of ${peer.name}'s own credentials, chosen by name. Its secret never reaches this instance.`}>
              <AppSelect value={credentialId} onValueChange={setCredentialId} placeholder="None (public repository)" options={[{ value: NO_CREDENTIAL, label: "None (public repository)" }, ...githubCredentials.map((credential) => ({ value: String(credential.id), label: credential.alias }))]} />
            </Field>
            <div><Button type="submit" disabled={creating || !name.trim() || !repo.trim()}>{creating ? <Loader size={13} className="spin" /> : <Plus size={13} />}Create on {peer.name}</Button></div>
          </Stack>
        </form>
      )}
    </main>
  );
}
