import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Loader } from "lucide-react";
import { api } from "../../api/client";
import { PeerBanner } from "../../components/PeerBanner";
import { PeerActions } from "./PeerActions";
import { PeerDomains } from "./PeerDomains";
import { PeerEnv } from "./PeerEnv";
import { PeerSettings } from "./PeerSettings";
import { TimeAgo } from "../../components/TimeAgo";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { queryKeys } from "../../lib/queryKeys";
import { usePeer } from "./PeerLayout";
import { ProjectStateBadge } from "./projectState";

type Tab = "overview" | "domains" | "env" | "deploys" | "logs" | "settings";
const TABS: { id: Tab; label: string; needs?: "projects:env" }[] = [{ id: "overview", label: "Overview" }, { id: "domains", label: "Hostnames" }, { id: "env", label: "Environment", needs: "projects:env" }, { id: "deploys", label: "Deploys" }, { id: "logs", label: "Logs" }, { id: "settings", label: "Settings" }];

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="grid grid-cols-[10rem_1fr] gap-2 border-b border-border py-2 text-[13px] last:border-b-0"><span className="text-[var(--dim)]">{label}</span><span className="min-w-0 break-words">{children}</span></div>;
}

const failure = (error: unknown, fallback: string): string => (error instanceof Error ? error.message : fallback);

const LOG_LINES = 200;

/** One project on a peer, read only: its configuration as the peer reports it, its deploy history, and its logs. Keyed by project, so moving to
 *  another project starts on Overview instead of opening its logs unprompted. */
export default function PeerProject() {
  const projectId = Number(useParams().projectId);
  return <PeerProjectView key={projectId} projectId={projectId} />;
}

function PeerProjectView({ projectId }: { projectId: number }) {
  const peer = usePeer();
  const [tab, setTab] = useState<Tab>("overview");
  const project = useQuery({ queryKey: queryKeys.peerProject(peer.id, projectId), queryFn: () => api.getPeerProject(peer.id, projectId), refetchInterval: 30_000, retry: false });
  const deploys = useQuery({ queryKey: queryKeys.peerDeploys(peer.id, projectId), queryFn: () => api.getPeerProjectDeploys(peer.id, projectId), enabled: tab === "deploys", retry: false });
  const logs = useQuery({ queryKey: queryKeys.peerLogs(peer.id, projectId), queryFn: () => api.getPeerProjectLogs(peer.id, projectId, LOG_LINES), enabled: tab === "logs", retry: false, gcTime: 0 });
  const detail = project.data?.data;

  return (
    <main className="main">
      <PeerBanner peer={peer} stale={project.data?.stale} fetchedAt={project.data?.fetchedAt} />
      <Link to={`/peers/${peer.id}`} className="mb-3 inline-flex items-center gap-1 text-xs underline"><ArrowLeft size={12} />{peer.name}: projects</Link>

      {project.isLoading ? <div className="empty" style={{ padding: 48 }}><Loader size={22} className="spin" /></div> : project.error || !detail ? (
        <Alert variant="destructive"><AlertDescription>{failure(project.error, "Couldn't read this project.")}</AlertDescription></Alert>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <h1 className="page-title">{detail.name}</h1>
            <ProjectStateBadge state={detail.status?.state} />
            <Badge variant="outline">on {peer.name}</Badge>
            {detail.paused && <Badge variant="secondary">Paused</Badge>}
          </div>
          <PeerActions peer={peer} project={detail} />
          <div className="mb-4 flex flex-wrap gap-1.5" role="tablist">
            {TABS.filter(({ needs }) => !needs || peer.grants.includes(needs)).map(({ id, label }) => (
              <Button key={id} type="button" role="tab" aria-selected={tab === id} size="sm" variant={tab === id ? "default" : "outline"} onClick={() => setTab(id)}>{label}</Button>
            ))}
          </div>

          {tab === "overview" && (
            <div className="card">
              <Row label="Source">{detail.sourceType === "upload" ? "Uploaded files" : `${detail.githubRepo ?? "GitHub"}${detail.branch ? ` @ ${detail.branch}` : ""}`}</Row>
              <Row label="Containers">{detail.status ? `${detail.status.containers.running} of ${detail.status.containers.total} running` : "Unknown"}</Row>
              <Row label="Health">{detail.status?.health ?? "unknown"}{detail.healthCheck.endpoint ? ` (${detail.healthCheck.endpoint}, every ${detail.healthCheck.intervalS}s)` : ""}</Row>
              {detail.status?.traffic && <Row label="Traffic">{detail.status.traffic.requests} requests in {Math.round(detail.status.traffic.windowS / 60)} min{detail.status.traffic.p95Ms !== null ? `, p95 ${detail.status.traffic.p95Ms} ms` : ""}{detail.status.traffic.errorRatePct !== null ? `, ${detail.status.traffic.errorRatePct}% server errors` : ""}</Row>}
              <Row label="Domains">{detail.domains.length === 0 ? "None" : detail.domains.map((domain) => <span key={domain.id} className="mono mr-3">{domain.domain}</span>)}</Row>
              <Row label="Last commit">{detail.lastCommit ? <>{detail.lastCommit.message ?? detail.lastCommit.sha.slice(0, 7)} <span className="text-[var(--dim)]">by {detail.lastCommit.author ?? "unknown"}, <TimeAgo ts={detail.lastCommit.at} /></span></> : "None yet"}</Row>
              <Row label="Compose file">{detail.composeFile ?? "Default"}</Row>
              <Row label="Deploy trigger">{detail.deployTrigger}</Row>
              <Row label="Protections">{[detail.hardenedDefaults && "hardened defaults", detail.composePolicyEnforced && "Compose policy", detail.volumesManaged && "managed volumes", detail.ingressIsolated && "isolated ingress"].filter(Boolean).join(", ") || "None"}</Row>
              <Row label="Created"><TimeAgo ts={detail.createdAt} /></Row>
            </div>
          )}

          {tab === "domains" && <PeerDomains peer={peer} projectId={projectId} />}
          {tab === "env" && <PeerEnv peer={peer} projectId={projectId} />}
          {tab === "settings" && <PeerSettings peer={peer} project={detail} />}

          {tab === "deploys" && (
            <div className="card">
              {deploys.isLoading ? <Loader size={14} className="spin" /> : deploys.error ? <Alert variant="destructive"><AlertDescription>{failure(deploys.error, "Couldn't read the history.")}</AlertDescription></Alert> : (deploys.data?.data.deploys.length ?? 0) === 0 ? <div className="empty">No deploys yet.</div> : (
                <ul>
                  {deploys.data?.data.deploys.map((deploy) => (
                    <li key={deploy.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border py-2.5 text-[13px] last:border-b-0">
                      <Badge variant={deploy.status === "failed" ? "destructive" : deploy.status === "running" ? "secondary" : "default"}>{deploy.status}</Badge>
                      <span>{deploy.kind}</span>
                      {deploy.commitSha && <span className="mono text-xs">{deploy.commitSha.slice(0, 7)}</span>}
                      {deploy.commitMessage && <span className="min-w-0 truncate text-[var(--dim)]">{deploy.commitMessage}</span>}
                      <span className="ml-auto text-xs text-[var(--dim)]">{deploy.triggeredBy}, <TimeAgo ts={deploy.createdAt} /></span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {tab === "logs" && (
            <div className="card">
              {logs.isLoading ? <Loader size={14} className="spin" /> : logs.error ? <Alert variant="destructive"><AlertDescription>{failure(logs.error, "Couldn't read the logs.")}</AlertDescription></Alert> : (
                <>
                  <div className="mb-2 flex items-center"><span className="text-xs text-[var(--dim)]">The last {LOG_LINES} lines, read from {peer.name} now. Not stored here.</span><Button type="button" size="sm" variant="outline" className="ml-auto" onClick={() => void logs.refetch()}>Refresh</Button></div>
                  <pre className="output-block overflow-x-auto text-xs">{logs.data?.data.output || "No output."}</pre>
                </>
              )}
            </div>
          )}
        </>
      )}
    </main>
  );
}
