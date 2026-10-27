import { Outlet, useLocation } from "react-router-dom";
import { Settings as SettingsIcon, SlidersHorizontal, GitBranch, Bell, Wrench, KeyRound, ShieldCheck } from "lucide-react";
import SubShell, { SubShellSectionHeader } from "../../components/SubShell";

export const SETTINGS_SECTIONS = [
  { path: "general", label: "General", icon: SlidersHorizontal, description: "Stackport version, updates and the admin password." },
  { path: "deploy-triggers", label: "Deploy triggers", icon: GitBranch, description: "How new commits reach Stackport: the GitHub poller and webhooks." },
  { path: "notifications", label: "Notifications", icon: Bell, description: "Email alerts for project health, a test send and the recent email log." },
  { path: "credentials", label: "Credentials", icon: ShieldCheck, description: "GitHub tokens, API keys and webhook secrets, stored encrypted." },
  { path: "mcp", label: "MCP", icon: KeyRound, description: "API tokens for the read-only MCP endpoint." },
  { path: "maintenance", label: "Maintenance", icon: Wrench, description: "Housekeeping checks for the deploy folder." },
] as const;

export default function SettingsLayout() {
  const { pathname } = useLocation();
  const active = SETTINGS_SECTIONS.find(({ path }) => pathname.startsWith(`/settings/${path}`));
  return (
    <SubShell title="Settings" icon={SettingsIcon} basePath="/settings" sections={SETTINGS_SECTIONS}>
      {active && <SubShellSectionHeader title={active.label} icon={active.icon} description={active.description} />}
      <Outlet />
    </SubShell>
  );
}
