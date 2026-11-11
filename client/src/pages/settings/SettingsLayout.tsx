import { Outlet, useLocation } from "react-router-dom";
import { Settings as SettingsIcon, SlidersHorizontal, GitBranch, Bell, Wrench, HardDrive, KeyRound, ShieldCheck, Lock, Shield, ShieldAlert, Plug, Globe } from "lucide-react";
import SubShell, { SubShellSectionHeader } from "../../components/SubShell";

export const SETTINGS_SECTIONS = [
  { path: "general", label: "General", icon: SlidersHorizontal, description: "Stackport version, updates and the admin password." },
  { path: "deploy-triggers", label: "Deploy triggers", icon: GitBranch, description: "How new commits reach Stackport: the GitHub poller and webhooks." },
  { path: "notifications", label: "Notifications", icon: Bell, description: "Email and browser push alerts, event preferences, registered browsers and delivery history." },
  { path: "domains", label: "Domains", icon: Globe, description: "The base domains Stackport manages, and every hostname on them: project, route, SSL and certificate." },
  { path: "github", label: "GitHub", icon: Plug, description: "The GitHub App this instance registers: deploy from repositories without a personal access token." },
  { path: "credentials", label: "Credentials", icon: ShieldCheck, description: "GitHub tokens, API keys and webhook secrets, stored encrypted." },
  { path: "mcp", label: "MCP", icon: KeyRound, description: "The tools Claude and other clients get, and the tokens that unlock them." },
  { path: "storage", label: "Storage", icon: HardDrive, description: "Docker disk usage, build-cache cleanup and the free-space thresholds that gate builds." },
  { path: "hardening", label: "Container defaults", icon: Shield, description: "Memory and process limits that projects with hardened defaults give every service." },
  { path: "enforcement", label: "Project protections", icon: ShieldAlert, description: "Which projects still lack the Compose policy, managed volumes or hardened defaults." },
  { path: "maintenance", label: "Maintenance", icon: Wrench, description: "Housekeeping checks for the deploy folder." },
  { path: "encryption", label: "Encryption", icon: Lock, description: "Re-encrypt the stored secrets under the current key, to finish a key rotation." },
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
