import { Outlet, useLocation } from "react-router-dom";
import { Settings as SettingsIcon, SlidersHorizontal, GitBranch, Bell, KeyRound, ShieldCheck, Lock, Shield, Plug, Globe } from "lucide-react";
import SubShell, { SubShellSectionHeader } from "../../components/SubShell";

export const SETTINGS_SECTIONS = [
  { path: "general", label: "General", icon: SlidersHorizontal, group: "Instance", description: "Stackport version, updates and the admin password." },
  { path: "notifications", label: "Notifications", icon: Bell, group: "Instance", description: "Email and browser push alerts, event preferences, registered browsers and delivery history." },
  { path: "deploy-triggers", label: "Deploy triggers", icon: GitBranch, group: "Deploy", description: "How new commits reach Stackport: the GitHub poller and webhooks." },
  { path: "domains", label: "Domains", icon: Globe, group: "Deploy", description: "The base domains Stackport manages, and every hostname on them: project, route, SSL and certificate." },
  { path: "protections", label: "Protections", icon: Shield, group: "Deploy", description: "The limits protected projects give their containers, and which projects still lack the Compose policy, managed volumes or hardened defaults." },
  { path: "github", label: "GitHub", icon: Plug, group: "Integrations", description: "The GitHub App this instance registers: deploy from repositories without a personal access token." },
  { path: "credentials", label: "Credentials", icon: ShieldCheck, group: "Integrations", description: "GitHub tokens, API keys and webhook secrets, stored encrypted." },
  { path: "mcp", label: "MCP", icon: KeyRound, group: "Integrations", description: "The tools Claude and other clients get, and the tokens that unlock them." },
  { path: "encryption", label: "Encryption", icon: Lock, group: "Security", description: "Re-encrypt the stored secrets under the current key, to finish a key rotation." },
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
