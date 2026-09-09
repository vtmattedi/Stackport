import { useEffect, useState } from "react";
import { NavLink, Link, useNavigate, useLocation } from "react-router-dom";
import { HoverCard } from "radix-ui";
import {
  ScrollText, FolderDot, Monitor, LogOut, KeyRound,
  ShieldCheck, Cpu, Wifi, WifiOff, ChevronLeft, ChevronRight,
  Layers, Box, GitBranch, Shield, Loader, BarChart2, Radar, Plug, Star,
} from "lucide-react";
import { api, clearToken } from "../api/client";
import { useSocket } from "../context/SocketContext";
import { useSystem } from "../context/SystemContext";
import { cn } from "../lib/utils";
import { deriveProjectStatus, findProjectStack, projectStatusLabel, type ProjectStatusKind } from "../lib/projectStatus";
import { StackPortBrand } from "../logo/StackPortBrand";
import styles from "./Nav.module.scss";
import type { GitHubPollerConfig, Project, SystemData, VpsData } from "../api/types";

// Keep in sync with $submenu-open-delay in Nav.module.scss: the trigger's
// hover sweep is timed to this, so the submenu wipe starts exactly when the
// sweep reaches the sidebar's edge.
const SUBMENU_OPEN_DELAY_MS = 500;

type TriState = boolean | null;

const SYSTEM_TABS: { tab: string; label: string; icon: typeof Layers }[] = [
  { tab: "nginx", label: "Nginx", icon: Layers },
  { tab: "docker", label: "Docker", icon: Box },
  { tab: "certbot", label: "Certbot", icon: ShieldCheck },
  { tab: "github", label: "GitHub", icon: GitBranch },
  { tab: "firewall", label: "Firewall", icon: Shield },
];

function dockerHasRunning(docker: SystemData["docker"]): boolean {
  const containers = [...docker.stacks.flatMap((stack) => stack.containers), ...docker.standalone];
  return containers.some((c) => c.state === "running");
}

function tabIconClass(state: TriState): string {
  return state === null ? styles.tabIconUnknown : state ? styles.tabIconOk : styles.tabIconFail;
}

function squircleClass(status: ProjectStatusKind): string {
  if (status === "ready") return styles.squircleReady;
  if (status === "down") return styles.squircleDown;
  if (status === "problem") return styles.squircleProblem;
  if (status === "paused") return styles.squirclePaused;
  return styles.squircleNotDeployed;
}

function SystemSubmenu({ system, github, vps }: { system: SystemData | null; github: GitHubPollerConfig | null; vps: VpsData | null }) {
  const states: Record<string, TriState> = {
    nginx: system ? !!system.nginx.available && !!system.nginx.active : null,
    docker: system ? !!system.docker.available && dockerHasRunning(system.docker) : null,
    certbot: system ? !!system.certbot.available : null,
    github: github ? github.enabled : null,
    firewall: vps ? vps.providers.length > 0 : null,
  };

  return (
    <>
      <div className={styles.submenuHeader}>System</div>
      <div className={styles.submenuList}>
        {SYSTEM_TABS.map(({ tab, label, icon: Icon }) => (
          <Link key={tab} to={`/system?tab=${tab}`} className={styles.submenuItem}>
            <Icon size={14} className={tabIconClass(states[tab])} />
            <span className={styles.submenuItemLabel}>{label}</span>
          </Link>
        ))}
      </div>
    </>
  );
}

function ProjectsSubmenu({ projects }: { projects: Project[] | null }) {
  const { system } = useSystem();
  return (
    <>
      <div className={styles.submenuHeader}>Projects</div>
      {projects === null ? (
        <div className={styles.submenuEmpty}>
          <Loader size={14} className="spin" />
        </div>
      ) : projects.length === 0 ? (
        <div className={styles.submenuEmpty}>No projects yet.</div>
      ) : (
        <div className={cn(styles.submenuList, styles.submenuScroll)}>
          {projects.map((project) => {
            const status = deriveProjectStatus(
              project,
              system?.docker ? findProjectStack(project, system.docker.stacks) : null,
              system?.docker?.available ?? false,
            );
            return (
              <Link key={project.id} to={`/projects/${project.id}`} className={styles.submenuItem}>
                <span
                  className={cn(styles.squircle, squircleClass(status))}
                  title={projectStatusLabel(status)}
                />
                {project.favorite && (
                  <Star size={11} fill="currentColor" style={{ color: "var(--brand)", flexShrink: 0 }} />
                )}
                <span className={styles.submenuItemLabel}>{project.name}</span>
                {project.paused && <span className={styles.submenuBadge}>Paused</span>}
              </Link>
            );
          })}
        </div>
      )}
      <div className={styles.submenuFooter}>
        <Link to="/projects" className={styles.submenuFooterLink}>View all projects</Link>
      </div>
    </>
  );
}

export default function Nav() {
  const navigate = useNavigate();
  const location = useLocation();
  const { connected, latencyMs, disconnect } = useSocket();
  const { system, projects, vps, github } = useSystem();
  const [expanded, setExpanded] = useState(() => {
    return localStorage.getItem("sidebar-expanded") === "true";
  });

  const projectsActive = location.pathname.startsWith("/projects");
  const systemActive = location.pathname.startsWith("/system");

  useEffect(() => {
    localStorage.setItem("sidebar-expanded", String(expanded));
  }, [expanded]);

  function logout() {
    void api.logout()
      .catch(() => {})
      .finally(() => {
        clearToken();
        disconnect();
        navigate("/");
      });
  }

  const statusLabel = connected
    ? latencyMs != null ? `${latencyMs} ms` : ""
    : "Disconnected";

  return (
    <nav className={cn(styles.nav, expanded && styles.expanded)}>
      <button
        type="button"
        className={styles.edgeToggle}
        onClick={() => setExpanded((v) => !v)}
        aria-label={expanded ? "Collapse sidebar" : "Expand sidebar"}
      >
        {expanded ? <ChevronLeft size={11} /> : <ChevronRight size={11} />}
      </button>

      <div className={styles.navHeader}>
        <StackPortBrand
          className={styles.navBrand}
          iconClassName={styles.brandLogo}
          wordmarkClassName={styles.brandText}
          iconSize={22}
          title="STACKPORT VPS Manager"
        />
      </div>

      <div className={styles.navLinks}>
        <HoverCard.Root openDelay={SUBMENU_OPEN_DELAY_MS} closeDelay={150}>
          <HoverCard.Trigger asChild>
            <NavLink
              to="/projects"
              title="Projects"
              className={cn(styles.navLink, styles.hasSubmenu, projectsActive && styles.active)}
            >
              <FolderDot size={16} />
              <span className={styles.linkText}>Projects</span>
            </NavLink>
          </HoverCard.Trigger>
          <HoverCard.Portal>
            <HoverCard.Content
              side="right"
              align="start"
              sideOffset={0}
              collisionPadding={8}
              className={styles.submenu}
            >
              <ProjectsSubmenu projects={projects} />
            </HoverCard.Content>
          </HoverCard.Portal>
        </HoverCard.Root>

        <NavLink
          to="/credentials"
          title="Credentials"
          className={({ isActive }) => cn(styles.navLink, isActive && styles.active)}
        >
          <ShieldCheck size={16} />
          <span className={styles.linkText}>Credentials</span>
        </NavLink>

        <HoverCard.Root openDelay={SUBMENU_OPEN_DELAY_MS} closeDelay={150}>
          <HoverCard.Trigger asChild>
            <NavLink
              to="/system"
              title="System"
              className={cn(styles.navLink, styles.hasSubmenu, systemActive && styles.active)}
            >
              <Cpu size={16} />
              <span className={styles.linkText}>System</span>
            </NavLink>
          </HoverCard.Trigger>
          <HoverCard.Portal>
            <HoverCard.Content
              side="right"
              align="start"
              sideOffset={0}
              collisionPadding={8}
              className={styles.submenu}
            >
              <SystemSubmenu system={system} github={github} vps={vps} />
            </HoverCard.Content>
          </HoverCard.Portal>
        </HoverCard.Root>

        <NavLink
          to="/infrastructure"
          title="Infrastructure"
          className={({ isActive }) => cn(styles.navLink, isActive && styles.active)}
        >
          <Monitor size={16} />
          <span className={styles.linkText}>Infrastructure</span>
        </NavLink>
        <NavLink
          to="/logs"
          title="Logs"
          className={({ isActive }) => cn(styles.navLink, isActive && styles.active)}
        >
          <ScrollText size={16} />
          <span className={styles.linkText}>Logs</span>
        </NavLink>
        <NavLink
          to="/metrics"
          title="Metrics"
          className={({ isActive }) => cn(styles.navLink, isActive && styles.active)}
        >
          <BarChart2 size={16} />
          <span className={styles.linkText}>Metrics</span>
        </NavLink>
        <NavLink
          to="/traffic"
          title="Traffic"
          className={({ isActive }) => cn(styles.navLink, isActive && styles.active)}
        >
          <Radar size={16} />
          <span className={styles.linkText}>Traffic</span>
        </NavLink>
        <NavLink
          to="/integrations"
          title="Integrations"
          className={({ isActive }) => cn(styles.navLink, isActive && styles.active)}
        >
          <Plug size={16} />
          <span className={styles.linkText}>Integrations</span>
        </NavLink>
        <NavLink
          to="/settings"
          title="Settings"
          className={({ isActive }) => cn(styles.navLink, isActive && styles.active)}
        >
          <KeyRound size={16} />
          <span className={styles.linkText}>Settings</span>
        </NavLink>
      </div>

      <div className={styles.navFooter}>
        <span
          className={cn(styles.navStatus, connected && styles.connected)}
          title={statusLabel}
        >
          {connected ? <Wifi size={14} /> : <WifiOff size={14} />}
          <span className={styles.linkText}>{statusLabel}</span>
        </span>
        <button
          className={cn(styles.navLink, styles.logoutBtn)}
          title="Logout"
          onClick={logout}
        >
          <LogOut size={16} />
          <span className={styles.linkText}>Logout</span>
        </button>
      </div>
    </nav>
  );
}
