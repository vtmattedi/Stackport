import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "../lib/utils";
import styles from "./ExpandableCard.module.scss";

interface ExpandableCardProps {
  title: ReactNode;
  icon?: ReactNode;
  summary?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  /** Rendered beside the header toggle (not inside it), so buttons here stay clickable without toggling the card. */
  actions?: ReactNode;
  /** When set, the open/closed state is remembered in localStorage under this key. */
  storageKey?: string;
}

const STORAGE_PREFIX = "stackport:expandable:";

function readStoredOpen(storageKey: string | undefined, fallback: boolean): boolean {
  if (!storageKey) return fallback;
  try {
    const stored = localStorage.getItem(STORAGE_PREFIX + storageKey);
    return stored === null ? fallback : stored === "1";
  } catch {
    return fallback;
  }
}

export function ExpandableCard({
  title,
  icon,
  summary,
  children,
  defaultOpen = false,
  className,
  actions,
  storageKey,
}: ExpandableCardProps) {
  const [open, setOpen] = useState(() => readStoredOpen(storageKey, defaultOpen));

  function toggle() {
    const next = !open;
    setOpen(next);
    if (!storageKey) return;
    try {
      localStorage.setItem(STORAGE_PREFIX + storageKey, next ? "1" : "0");
    } catch {
      // storage unavailable — state just won't persist
    }
  }

  return (
    <div className={cn("card", styles.root, className)}>
      <div className={styles.header}>
        <button
          type="button"
          className={styles.trigger}
          onClick={toggle}
          aria-expanded={open}
        >
          <ChevronRight
            size={14}
            className={cn(styles.chevron, open && styles.chevronOpen)}
          />
          {icon && <span className={styles.triggerIcon}>{icon}</span>}
          <span className={styles.triggerTitle}>{title}</span>
          {summary !== undefined && (
            <span className={styles.triggerSummary}>{summary}</span>
          )}
        </button>
        {actions && <div className={styles.actions}>{actions}</div>}
      </div>
      {open && <div className={styles.body}>{children}</div>}
    </div>
  );
}
