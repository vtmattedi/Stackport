import type { ReactNode } from "react";
import { NavLink, Outlet } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import { cn } from "../lib/utils";
import styles from "./SubShell.module.scss";

export interface SubShellSection {
  path: string;
  label: string;
  icon: LucideIcon;
  /** Tints the section icon green/red; leave unset while unknown. */
  status?: "ok" | "fail";
  badge?: ReactNode;
}

interface SubShellProps {
  title: string;
  icon: LucideIcon;
  /** Sections link to `${basePath}/${section.path}`. */
  basePath: string;
  sections: readonly SubShellSection[];
  /** Page-level controls shown beside the title. */
  actions?: ReactNode;
  /** The active section. Defaults to the nested route's <Outlet />. */
  children?: ReactNode;
  /** Extra classes for the page's <main>, e.g. a wider max-width. */
  className?: string;
}

/**
 * Shared layout for pages split into sections (Settings, System, Infrastructure…):
 * a title row, a section list beside (or, on phones, above) the active section.
 */
export default function SubShell({ title, icon: TitleIcon, basePath, sections, actions, children, className }: SubShellProps) {
  return (
    <main className={cn("main", className)}>
      <div className={styles.header}>
        <h1 className="page-title"><TitleIcon size={20} />{title}</h1>
        {actions && <div className={styles.headerActions}>{actions}</div>}
      </div>
      <div className={styles.shell}>
        <nav className={styles.sectionNav} aria-label={`${title} sections`}>
          {sections.map(({ path, label, icon: Icon, status, badge }) => (
            <NavLink
              key={path}
              to={`${basePath}/${path}`}
              className={({ isActive }) => cn(styles.sectionLink, isActive && styles.sectionLinkActive)}
            >
              <Icon size={14} className={cn(status === "ok" && styles.statusOk, status === "fail" && styles.statusFail)} />
              <span className={styles.sectionLabel}>{label}</span>
              {badge}
            </NavLink>
          ))}
        </nav>
        <div className={styles.body}>
          {children ?? <Outlet />}
        </div>
      </div>
    </main>
  );
}

interface SubShellSectionHeaderProps {
  title: ReactNode;
  icon?: LucideIcon;
  /** Small inline details beside the title: versions, status chips. */
  meta?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}

/** Title row at the top of a section body, so every section opens the same way. */
export function SubShellSectionHeader({ title, icon: Icon, meta, description, actions }: SubShellSectionHeaderProps) {
  return (
    <div className={styles.sectionHeader}>
      <div className={styles.sectionHeading}>
        <div className={styles.sectionTitleRow}>
          <h2 className={styles.sectionTitle}>{Icon && <Icon size={16} />}{title}</h2>
          {meta}
        </div>
        {description && <p className={styles.sectionDescription}>{description}</p>}
      </div>
      {actions && <div className={styles.headerActions}>{actions}</div>}
    </div>
  );
}
