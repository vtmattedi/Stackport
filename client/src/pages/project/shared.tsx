import type { ReactNode } from "react";
import styles from "../ProjectDetails.module.scss";

/** A label and value pair in a card's detail grid. */
export function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className={styles.detailRow}>
      <span className="muted-text">{label}</span>
      <span>{value}</span>
    </div>
  );
}

