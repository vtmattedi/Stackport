import { NavLink, Outlet } from "react-router-dom";
import { Settings as SettingsIcon, SlidersHorizontal, GitBranch, Server, Bell, Wrench } from "lucide-react";
import { cn } from "../../lib/utils";
import styles from "../Settings.module.scss";

export const SETTINGS_SECTIONS = [
  { path: "general", label: "General", icon: SlidersHorizontal },
  { path: "deploy-triggers", label: "Deploy triggers", icon: GitBranch },
  { path: "infrastructure", label: "Infrastructure", icon: Server },
  { path: "notifications", label: "Notifications", icon: Bell },
  { path: "maintenance", label: "Maintenance", icon: Wrench },
] as const;

/** Settings shell: a section list beside (or, on phones, above) the active section. */
export default function SettingsLayout() {
  return (
    <main className="main">
      <h1 className="page-title"><SettingsIcon size={20} />Settings</h1>
      <div className={styles.settingsShell}>
        <nav className={styles.sectionNav} aria-label="Settings sections">
          {SETTINGS_SECTIONS.map(({ path, label, icon: Icon }) => (
            <NavLink
              key={path}
              to={`/settings/${path}`}
              className={({ isActive }) => cn(styles.sectionLink, isActive && styles.sectionLinkActive)}
            >
              <Icon size={14} />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className={styles.sectionBody}>
          <Outlet />
        </div>
      </div>
    </main>
  );
}
