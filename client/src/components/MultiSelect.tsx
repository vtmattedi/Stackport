import { Popover } from "radix-ui";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "../lib/utils";
import styles from "./MultiSelect.module.scss";

export interface MultiSelectOption {
  value: string;
  label: string;
}

/** Empty `selected` means "all" — not a checkbox state, so it's excluded from the count/label. */
export function multiSelectSummary(selected: string[], options: MultiSelectOption[], allLabel = "All"): string {
  if (selected.length === 0) return allLabel;
  if (selected.length === 1) return options.find((o) => o.value === selected[0])?.label ?? selected[0];
  return `${selected.length} selected`;
}

export function MultiSelect({
  options, selected, onChange, allLabel = "All", triggerClassName,
}: {
  options: MultiSelectOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  allLabel?: string;
  triggerClassName?: string;
}) {
  function toggle(value: string, checked: boolean) {
    onChange(checked ? [...selected, value] : selected.filter((v) => v !== value));
  }
  const allSelected = selected.length === 0;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className={cn(styles.trigger, triggerClassName)}>
          <span className={styles.trunc}>{multiSelectSummary(selected, options, allLabel)}</span>
          <ChevronDown size={13} style={{ flexShrink: 0, opacity: 0.6 }} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={4} className={styles.panel}>
          {/* Not a checkbox — the "all" option is the computed empty-selection state,
              not an item you individually check, so it shouldn't render pre-ticked. */}
          <button
            type="button"
            className={cn(styles.action, allSelected && styles.actionActive)}
            onClick={() => onChange([])}
          >
            {allSelected && <Check size={13} />}
            <span>{allLabel}</span>
          </button>
          {options.length > 0 && <div className={styles.divider} />}
          {options.map((o) => (
            <label key={o.value} className={styles.row}>
              <input
                type="checkbox"
                checked={selected.includes(o.value)}
                onChange={(e) => toggle(o.value, e.target.checked)}
              />
              <span className={styles.trunc}>{o.label}</span>
            </label>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
