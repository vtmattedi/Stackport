import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { FolderDot, Loader, RefreshCw } from "lucide-react";
import { api } from "../../api/client";
import { PeerBanner } from "../../components/PeerBanner";
import { TimeAgo } from "../../components/TimeAgo";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { queryKeys } from "../../lib/queryKeys";
import { usePeer } from "./PeerLayout";
import { ProjectStateBadge } from "./projectState";

/** A peer's projects, read from the peer itself. Read only: nothing here changes the peer. */
export default function PeerProjects() {
  const peer = usePeer();
  const query = useQuery({ queryKey: queryKeys.peerProjects(peer.id), queryFn: () => api.getPeerProjects(peer.id), refetchInterval: 30_000, retry: false });
  const projects = query.data?.data.projects ?? null;

  return (
    <main className="main">
      <PeerBanner peer={peer} stale={query.data?.stale} fetchedAt={query.data?.fetchedAt} />
      <div className="mb-4 flex items-center gap-3">
        <h1 className="page-title"><FolderDot size={20} />{peer.name}: projects</h1>
        <Button type="button" variant="outline" size="sm" className="ml-auto" disabled={query.isFetching} onClick={() => void query.refetch()}>
          {query.isFetching ? <Loader size={13} className="spin" /> : <RefreshCw size={13} />}Refresh
        </Button>
      </div>

      {query.error && (
        <Alert variant="destructive" className="mb-4"><AlertDescription>
          {query.error instanceof Error ? query.error.message : "Couldn't read the peer's projects."}
        </AlertDescription></Alert>
      )}

      {query.isLoading ? <div className="empty" style={{ padding: 48 }}><Loader size={22} className="spin" /></div> : projects && projects.length === 0 ? (
        <div className="empty">{peer.name} has no projects yet.</div>
      ) : projects && (
        <div className="card">
          <ul>
            {projects.map((project) => (
              <li key={project.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border py-3 text-[13px] last:border-b-0">
                <Link to={`/peers/${peer.id}/projects/${project.id}`} className="font-medium underline-offset-2 hover:underline">{project.name}</Link>
                <ProjectStateBadge state={project.status?.state} />
                {project.status && project.status.containers.total > 0 && <span className="text-xs text-[var(--dim)]">{project.status.containers.running}/{project.status.containers.total} containers</span>}
                {project.githubRepo && <span className="mono text-xs text-[var(--dim)]">{project.githubRepo}{project.branch ? `@${project.branch}` : ""}</span>}
                <span className="ml-auto flex flex-wrap gap-x-3 text-xs text-[var(--dim)]">
                  {project.domains.slice(0, 2).map((domain) => <span key={domain.id} className="mono">{domain.domain}</span>)}
                  {project.domains.length > 2 && <span>+{project.domains.length - 2}</span>}
                  {project.lastCommit?.at && <span>commit <TimeAgo ts={project.lastCommit.at} /></span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </main>
  );
}
