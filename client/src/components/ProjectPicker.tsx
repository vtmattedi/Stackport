import { useMemo, useState } from "react";
import { Popover } from "radix-ui";
import { ChevronDown, FolderDot, Search, X } from "lucide-react";
import { cn } from "../lib/utils";
import styles from "./ProjectPicker.module.scss";

export interface ProjectPickerItem {
  value: string;
  label: string;
  /** Project group name; null lands in "Ungrouped". */
  group: string | null;
}

interface Group { key: string; name: string; items: ProjectPickerItem[] }

const UNGROUPED = "Ungrouped";

/** Named groups alphabetically, then Ungrouped, keeping each group's item order. */
export function groupProjectItems(items: ProjectPickerItem[]): Group[] {
  const byName = new Map<string, ProjectPickerItem[]>();
  for (const item of items) {
    const name = item.group || UNGROUPED;
    byName.set(name, [...(byName.get(name) ?? []), item]);
  }
  return [...byName.entries()]
    .sort(([a], [b]) => (a === UNGROUPED ? 1 : b === UNGROUPED ? -1 : a.localeCompare(b)))
    .map(([name, groupItems]) => ({ key: name, name, items: groupItems }));
}

/**
 * Trigger text, phrased in groups where it can be: "Mw Control + Infra",
 * "All but Staging", otherwise "3 of 12 projects".
 */
export function projectPickerSummary(selected: string[], items: ProjectPickerItem[], allLabel = "All projects"): string {
  const on = new Set(selected.filter((v) => items.some((i) => i.value === v)));
  if (on.size === 0 || on.size === items.length) return allLabel;
  if (on.size === 1) return items.find((i) => on.has(i.value))?.label ?? "1 project";
  const groups = groupProjectItems(items);
  if (groups.length > 1) {
    const full = groups.filter((g) => g.items.every((i) => on.has(i.value)));
    const none = groups.filter((g) => g.items.every((i) => !on.has(i.value)));
    if (full.length + none.length === groups.length) {
      if (full.length <= 2) return full.map((g) => g.name).join(" + ");
      if (none.length <= 2) return `All but ${none.map((g) => g.name).join(", ")}`;
    }
  }
  return `${on.size} of ${items.length} projects`;
}

/** Share of a group that's selected, drawn as a filling ring. Not a checkbox on purpose. */
function GroupDial({ fraction }: { fraction: number }) {
  const r = 6;
  const c = 2 * Math.PI * r;
  return (
    <svg className={styles.dial} width={16} height={16} viewBox="0 0 16 16" aria-hidden>
      <circle cx={8} cy={8} r={r} className={styles.dialTrack} />
      {fraction > 0 && <circle
        cx={8} cy={8} r={r}
        className={styles.dialFill}
        strokeDasharray={`${c * fraction} ${c}`}
        transform="rotate(-90 8 8)"
      />}
      {fraction === 1 && <circle cx={8} cy={8} r={2.5} className={styles.dialCore} />}
    </svg>
  );
}

/**
 * Project filter shared by every page that scopes by project. Projects are grouped by
 * their project group, and a group header includes or excludes the whole group at once.
 * `selected` empty means every project (so new projects show up without re-picking);
 * clearing the last project falls back to that.
 */
export function ProjectPicker({
  items, selected, onChange, allLabel = "All projects", triggerClassName, align = "start",
}: {
  items: ProjectPickerItem[];
  selected: string[];
  onChange: (next: string[]) => void;
  allLabel?: string;
  triggerClassName?: string;
  align?: "start" | "end";
}) {
  const [query, setQuery] = useState("");
  const groups = useMemo(() => groupProjectItems(items), [items]);
  const on = useMemo(() => {
    const valid = selected.filter((v) => items.some((i) => i.value === v));
    return new Set(valid.length ? valid : items.map((i) => i.value));
  }, [items, selected]);
  const isAll = on.size === items.length;
  const summary = projectPickerSummary(selected, items, allLabel);

  const term = query.trim().toLowerCase();
  const visibleGroups = term
    ? groups
      .map((g) => (g.name.toLowerCase().includes(term) ? g : { ...g, items: g.items.filter((i) => i.label.toLowerCase().includes(term)) }))
      .filter((g) => g.items.length > 0)
    : groups;

  function commit(next: Set<string>) {
    onChange(next.size === 0 || next.size === items.length ? [] : items.filter((i) => next.has(i.value)).map((i) => i.value));
  }
  function setMany(values: string[], value: boolean) {
    const next = new Set(on);
    for (const v of values) { if (value) next.add(v); else next.delete(v); }
    commit(next);
  }
  function only(values: string[]) {
    commit(new Set(values));
  }
  function invert() {
    commit(new Set(items.filter((i) => !on.has(i.value)).map((i) => i.value)));
  }

  return (
    <Popover.Root onOpenChange={(open) => { if (!open) setQuery(""); }}>
      <Popover.Trigger asChild>
        <button type="button" className={cn(styles.trigger, !isAll && styles.triggerScoped, triggerClassName)}>
          <FolderDot size={13} className={styles.triggerIcon} />
          <span className={styles.trunc}>{summary}</span>
          {!isAll && !summary.endsWith(" projects") && <span className={styles.triggerCount}>{on.size}/{items.length}</span>}
          <ChevronDown size={13} className={styles.chevron} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align={align} sideOffset={4} collisionPadding={12} className={styles.panel}>
          <div className={styles.head}>
            <label className={styles.search}>
              <Search size={13} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter projects or groups"
                aria-label="Filter projects or groups"
                autoFocus
              />
              {query && (
                <button type="button" className={styles.clearSearch} onClick={() => setQuery("")} aria-label="Clear filter">
                  <X size={12} />
                </button>
              )}
            </label>
            <div className={styles.quick}>
              <button type="button" className={cn(styles.quickBtn, isAll && styles.quickBtnActive)} onClick={() => onChange([])}>
                All
              </button>
              <button type="button" className={styles.quickBtn} onClick={invert} disabled={isAll} title="Swap included and excluded projects">
                Invert
              </button>
            </div>
          </div>

          <div className={styles.list}>
            {visibleGroups.length === 0 && <div className={styles.empty}>Nothing matches “{query.trim()}”.</div>}
            {visibleGroups.map((g) => {
              const values = g.items.map((i) => i.value);
              const count = values.filter((v) => on.has(v)).length;
              const full = count === values.length;
              return (
                <section key={g.key} className={styles.group}>
                  <div className={styles.groupHead}>
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={full ? true : count === 0 ? false : "mixed"}
                      className={cn(styles.groupToggle, count > 0 && styles.groupToggleOn)}
                      onClick={() => setMany(values, !full)}
                      title={full ? `Exclude ${g.name}` : `Include all of ${g.name}`}
                    >
                      <GroupDial fraction={values.length ? count / values.length : 0} />
                      <span className={cn(styles.groupName, styles.trunc)}>{g.name}</span>
                      <span className={styles.groupCount}>{count}/{values.length}</span>
                    </button>
                    <button type="button" className={styles.onlyBtn} onClick={() => only(values)} aria-label={`Only ${g.name}`}>
                      only
                    </button>
                  </div>
                  <div className={styles.items}>
                    {g.items.map((item) => {
                      const active = on.has(item.value);
                      return (
                        <div key={item.value} className={styles.itemRow}>
                          <button
                            type="button"
                            role="checkbox"
                            aria-checked={active}
                            className={cn(styles.item, active && styles.itemOn)}
                            onClick={() => setMany([item.value], !active)}
                          >
                            <span className={styles.led} aria-hidden />
                            <span className={styles.trunc}>{item.label}</span>
                          </button>
                          <button type="button" className={styles.onlyBtn} onClick={() => only([item.value])} aria-label={`Only ${item.label}`}>
                            only
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>

          <div className={styles.foot}>
            {isAll ? `All ${items.length} projects` : `${on.size} of ${items.length} included · ${items.length - on.size} excluded`}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
