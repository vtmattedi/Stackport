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
}

export function ExpandableCard({
  title,
  icon,
  summary,
  children,
  defaultOpen = false,
  className,
}: ExpandableCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={cn("card", styles.root, className)}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        {icon && <span className={styles.triggerIcon}>{icon}</span>}
        <span className={styles.triggerTitle}>{title}</span>
        {summary !== undefined && (
          <span className={styles.triggerSummary}>{summary}</span>
        )}
        <ChevronRight
          size={14}
          className={cn(styles.chevron, open && styles.chevronOpen)}
        />
      </button>
      {open && <div className={styles.body}>{children}</div>}
    </div>
  );
}
