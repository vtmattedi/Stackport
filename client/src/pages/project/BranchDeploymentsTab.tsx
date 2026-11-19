import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranch, Plus } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../../api/client";
import type { Project, ProjectDomain } from "../../api/types";
import { AppSelect } from "../../components/AppSelect";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { CheckRow, Field } from "../../components/ui/field";
import { Stack } from "../../components/ui/stack";
import { Hint } from "../../components/ui/text";

export function BranchDeploymentsTab({ project, domains }: { project: Project; domains: ProjectDomain[] }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [branch, setBranch] = useState("");
  const [env, setEnv] = useState<"shared" | "separate">("separate");
  const [commentOnPullRequest, setComment] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const queryKey = ["branch-deployments", project.id];
  const deployments = useQuery({ queryKey, queryFn: () => api.listBranchDeployments(project.id), refetchInterval: 10_000 });
  const branches = useQuery({ queryKey: ["branch-deployment-options", project.id], queryFn: () => api.getProjectBranches(project.id) });
  const primary = branches.data?.autoDeployBranch ?? project.autoDeployBranch;
  const taken = new Set([primary, ...(deployments.data?.map((item) => item.autoDeployBranch) ?? [])]);
  const choices = (branches.data?.branches ?? project.branches).filter((item) => !taken.has(item.name));

  async function addDeployment() {
    if (!branch || creating) return;
    setCreating(true);
    setError("");
    try {
      const created = await api.createBranchDeployment(project.id, { branch, env, commentOnPullRequest });
      await queryClient.invalidateQueries({ queryKey });
      navigate(`/projects/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add the branch deployment.");
    } finally { setCreating(false); }
  }

  return (
    <section className="card">
      <div className="card-title"><GitBranch size={14} /> Branch deployments</div>
      <Stack gap={4}>
        <div className="row-actions"><strong>{primary ?? "Primary deployment"}</strong> <span className="muted-text">Primary</span><DomainLink domain={domains[0]} /></div>
        {deployments.isLoading && <Hint>Loading branch deployments…</Hint>}
        {deployments.error && <div className="alert alert-error">{deployments.error.message}</div>}
        {deployments.data?.map((item) => (
          <div key={item.id} className="row-actions">
            <Link to={`/projects/${item.id}`} className="mono">{item.autoDeployBranch}</Link>
            <DomainLink domain={item.domains[0]} />
            <span className="muted-text">{item.branchShareEnv ? "Shared env" : "Separate env"}</span>
            <Button type="button" asChild variant="outline" size="sm"><Link to={`/projects/${item.id}`}>Manage</Link></Button>
          </div>
        ))}
        <form onSubmit={(event) => { event.preventDefault(); void addDeployment(); }}>
          <Stack gap={3}>
            <Field label="Branch" hint="Stackport generates a hostname under your default base domain.">
              <div className="row-actions">
                <AppSelect value={branch} onValueChange={setBranch} placeholder="Choose a branch" options={choices.map((item) => ({ value: item.name, label: item.name }))} disabled={creating} />
                <Button type="button" variant="outline" size="sm" disabled={branches.isFetching} onClick={() => {
                  void api.getProjectBranches(project.id, true).then((result) => queryClient.setQueryData(["branch-deployment-options", project.id], result))
                    .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load branches."));
                }}>Refresh branches</Button>
              </div>
            </Field>
            {branches.error && <Hint>{branches.error.message}</Hint>}
            <Field label="Environment files" hint={env === "shared" ? "Uses the primary deployment's current env files each time this branch deploys." : "Starts empty. Add the branch's values before deploying."}>
              <AppSelect value={env} onValueChange={(value) => setEnv(value === "shared" ? "shared" : "separate")} options={[{ value: "separate", label: "Separate env files" }, { value: "shared", label: "Share the primary deployment's env files" }]} disabled={creating} />
            </Field>
            {project.githubAuthMode === "app" && <CheckRow title="Post the preview URL on the pull request" hint="Requires Pull requests: Read and write on the GitHub App." control={<Checkbox checked={commentOnPullRequest} onCheckedChange={(value) => setComment(value === true)} disabled={creating} />} />}
            {error && <div className="alert alert-error">{error}</div>}
            <div><Button type="submit" disabled={creating || !branch || taken.has(branch)}><Plus size={14} />{creating ? "Adding…" : "Add branch deployment"}</Button></div>
          </Stack>
        </form>
      </Stack>
    </section>
  );
}

function DomainLink({ domain }: { domain?: ProjectDomain }) {
  if (!domain) return null;
  if (!domain.service || !domain.containerPort) return <span className="muted-text mono">{domain.domain} (waiting for route)</span>;
  return <a className="mono" href={`${domain.useSsl ? "https" : "http"}://${domain.domain}`} target="_blank" rel="noreferrer">{domain.domain}</a>;
}
