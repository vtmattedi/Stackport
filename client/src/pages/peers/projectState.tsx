import type { RemoteProjectState } from "../../api/types";
import { Badge } from "../../components/ui/badge";

const STATE: Record<RemoteProjectState, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  ready: { label: "Ready", variant: "default" },
  problem: { label: "Problem", variant: "destructive" },
  down: { label: "Down", variant: "destructive" },
  "not-deployed": { label: "Not deployed", variant: "outline" },
  paused: { label: "Paused", variant: "secondary" },
};

export function ProjectStateBadge({ state }: { state: RemoteProjectState | undefined }) {
  const entry = state ? STATE[state] : undefined;
  return entry ? <Badge variant={entry.variant}>{entry.label}</Badge> : <Badge variant="outline">Unknown</Badge>;
}
