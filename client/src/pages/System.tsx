import { Navigate, useParams, useSearchParams } from "react-router-dom";
import { Cpu, RefreshCw } from "lucide-react";
import SubShell from "../components/SubShell";
import { Button } from "../components/ui/button";
import { useSystem } from "../context/SystemContext";
import { HOST_SECTIONS, isHostTab, type HostTab } from "../lib/hostSections";
import { HardwareSection } from "./HardwareSection";
import { CertbotSection } from "./system/CertbotSection";
import { DockerSection } from "./system/DockerSection";
import { NetworksSection } from "./system/NetworksSection";
import { NginxSection } from "./system/NginxSection";
import { PowerSection } from "./system/PowerSection";

/** The Host page: sections live at /host/:section. Old /system/:section and
 *  /system?tab= links (including the poller and firewall, which moved to Settings)
 *  still land in the right place. */
export default function System() {
  const { section } = useParams();
  const [searchParams] = useSearchParams();
  const tab = searchParams.get("tab");
  if (tab === "github") return <Navigate to="/settings/deploy-triggers" replace />;
  // The firewall tab was the Hostinger firewall, since removed.
  if (tab === "firewall") return <Navigate to="/host" replace />;
  if (!section || !isHostTab(section)) {
    return <Navigate to={`/host/${tab && isHostTab(tab) ? tab : "hardware"}`} replace />;
  }
  return <SystemPage activeTab={section} />;
}

/** Sections that read the shared system snapshot (Docker, Nginx, Certbot) have their own Refresh here; the others load their own data. */
const SNAPSHOT_TABS: HostTab[] = ["docker", "nginx", "certbot"];

function SystemPage({ activeTab }: { activeTab: HostTab }) {
  const { system: data, refreshSystem: refresh } = useSystem();
  const loading = data === null;

  // The dot beside a section in the list: is the thing it shows working.
  const dockerHasRunningContainers = [...(data?.docker.stacks ?? []).flatMap((stack) => stack.containers), ...(data?.docker.standalone ?? [])]
    .some((container) => container.state === "running");
  const ok: Partial<Record<HostTab, boolean>> = {
    nginx: !!data?.nginx.available && !!data.nginx.active,
    docker: !!data?.docker.available && dockerHasRunningContainers,
    certbot: !!data?.certbot.available,
  };
  const sectionStatus = (tab: HostTab) => (loading || !(tab in ok) ? undefined : ok[tab] ? "ok" as const : "fail" as const);

  return (
    <SubShell
      title="Host"
      icon={Cpu}
      basePath="/host"
      sections={HOST_SECTIONS.map(({ tab, label, icon }) => ({ path: tab, label, icon, status: sectionStatus(tab) }))}
      actions={SNAPSHOT_TABS.includes(activeTab) ? (
        <Button type="button" variant="outline" size="xs" onClick={refresh} disabled={loading}>
          <RefreshCw size={13} />
          Refresh
        </Button>
      ) : undefined}
    >
      {activeTab === "hardware" ? <HardwareSection />
        : activeTab === "docker" ? <DockerSection />
          : activeTab === "networks" ? <NetworksSection />
            : activeTab === "nginx" ? <NginxSection />
              : activeTab === "certbot" ? <CertbotSection />
                : <PowerSection />}
    </SubShell>
  );
}
