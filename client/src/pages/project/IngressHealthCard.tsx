import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Loader, RefreshCw, TriangleAlert } from "lucide-react";
import { api } from "../../api/client";
import { Button } from "../../components/ui/button";

const FAILURE_LABEL: Record<string, string> = {
  "name-does-not-resolve": "name does not resolve",
  "connection-refused": "connection refused",
  "timed-out": "no answer",
  "probe-failed": "could not be checked",
};

/** Whether nginx can reach each routed service right now, asked from inside nginx's own network. It does not
 *  look at what the application answers, so an app's own 500 is not shown as a routing problem. */
export function IngressHealthCard({ projectId }: { projectId: number }) {
  const { data, isFetching, refetch, error } = useQuery({
    queryKey: ["project", projectId, "ingress-health"],
    queryFn: () => api.getProjectIngressHealth(projectId),
    retry: false,
  });

  if (error) return null;
  if (!data) return <Loader size={14} className="spin" />;
  if (data.status === "no-routes") return null;
  const ok = data.status === "ok";

  return (
    <div className="card" role="status">
      <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" }}>
        <strong style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {ok ? <CheckCircle2 size={14} /> : <TriangleAlert size={14} />}
          Routing: {ok ? "every route reaches its service" : data.status === "degraded" ? "some routes are unreachable" : data.status === "down" ? "no route reaches its service" : "nginx cannot reach any service"}
        </strong>
        <Button type="button" size="sm" variant="outline" disabled={isFetching} onClick={() => void refetch()}>
          {isFetching ? <Loader size={14} className="spin" /> : <RefreshCw size={14} />} Check again
        </Button>
      </div>
      {!ok && <p className="hint">{data.summary}</p>}
      {data.routes.length > 0 && (
        <table>
          <thead><tr><th>Domain</th><th>Service</th><th>Port</th><th>Reachable from nginx</th></tr></thead>
          <tbody>
            {data.routes.map((route) => (
              <tr key={route.domain}>
                <td className="mono">{route.domain}</td>
                <td className="mono">{route.service}</td>
                <td className="mono">{route.port}</td>
                <td>{route.reachable ? "yes" : FAILURE_LABEL[route.failure ?? "probe-failed"] ?? route.failure}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
