import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { api } from "../../api/client";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";

/** How many more Docker networks fit. Silent while there is plenty of room; when Docker's address
 *  pool is nearly used up it says so and how to enlarge it, since the next deploy that needs a network would fail. */
export function NetworkHeadroomNotice() {
  const { data } = useQuery({
    queryKey: ["system", "network-headroom"],
    queryFn: () => api.getNetworkHeadroom(),
    refetchInterval: 60_000,
    retry: false,
  });
  if (!data || data.level === "ok") return null;

  return (
    <Alert variant={data.level === "critical" ? "destructive" : "default"} role="alert">
      <AlertTriangle size={14} />
      <AlertTitle>
        {data.level === "critical" ? "Docker is almost out of network address space" : "Docker's network address space is filling up"}
      </AlertTitle>
      <AlertDescription>
        <p>
          {data.used} of {data.capacity} address-pool slices are used, so {data.free} more {data.free === 1 ? "network fits" : "networks fit"}.
          {!data.poolsKnown && " (The daemon's own settings could not be read, so Docker's defaults are assumed.)"}
        </p>
        {data.advice && <p>{data.advice}</p>}
      </AlertDescription>
    </Alert>
  );
}
