import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { cn } from "../lib/utils";

export interface ComboboxOption {
  value: string;
  /** What is shown, and what the search matches. */
  label: string;
  /** A second line under the label (a description, a date). It is searched too. */
  description?: string;
  /** Small marks to the right: "private", "compose file". */
  badges?: ReactNode;
  /** The group heading it sits under; options with the same group are kept together, in the order they first appear. */
  group?: string;
  disabled?: boolean;
}

/**
 * A select you can type into, for lists that are too long to scroll: repositories, branches. The native <select> has no search and
 * cannot be styled; AppSelect is for short lists. Arrow keys move, Enter picks, Escape closes.
 */
export function Combobox({ value, onValueChange, options, placeholder = "Select", searchPlaceholder = "Search", emptyText = "Nothing matches.", disabled, className, id }: {
  value: string;
  onValueChange: (value: string) => void;
  options: ComboboxOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  const selected = options.find((option) => option.value === value);
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return options.filter((option) => !needle || `${option.label} ${option.description ?? ""}`.toLowerCase().includes(needle));
  }, [options, query]);

  // Group headings need the options of a group next to each other; keep the order in which groups first appear.
  const rows = useMemo(() => {
    const order: string[] = [];
    for (const option of matches) { const group = option.group ?? ""; if (!order.includes(group)) order.push(group); }
    return order.flatMap((group) => matches.filter((option) => (option.group ?? "") === group));
  }, [matches]);

  useEffect(() => { setActive(0); }, [query, open]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function pick(option: ComboboxOption | undefined) {
    if (!option || option.disabled) return;
    onValueChange(option.value);
    setOpen(false);
    setQuery("");
  }

  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setQuery(""); }}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          disabled={disabled}
          className={cn(
            "flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 text-left text-sm shadow-xs outline-none transition-[color,box-shadow] dark:bg-input/30",
            "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
            !selected && "text-muted-foreground",
            className,
          )}
        >
          <span className="truncate">{selected ? selected.label : placeholder}</span>
          <ChevronDown size={14} className="shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) min-w-[260px] p-0">
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search size={14} className="shrink-0 opacity-60" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            aria-controls={listId}
            className="h-9 w-full border-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") { event.preventDefault(); setActive((i) => Math.min(i + 1, rows.length - 1)); }
              else if (event.key === "ArrowUp") { event.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
              else if (event.key === "Enter") { event.preventDefault(); pick(rows[active]); }
            }}
          />
        </div>
        <div ref={listRef} id={listId} role="listbox" className="max-h-72 overflow-y-auto p-1">
          {rows.length === 0 && <div className="px-3 py-6 text-center text-xs text-[var(--dim)]">{emptyText}</div>}
          {rows.map((option, index) => (
            <div key={option.value}>
              {(index === 0 || (rows[index - 1].group ?? "") !== (option.group ?? "")) && option.group && (
                <div className="px-2 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-[var(--dim)] uppercase">{option.group}</div>
              )}
              <div
                role="option"
                aria-selected={option.value === value}
                aria-disabled={option.disabled}
                data-index={index}
                onMouseEnter={() => setActive(index)}
                onClick={() => pick(option)}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm",
                  index === active && "bg-accent",
                  option.disabled && "cursor-not-allowed opacity-50",
                )}
              >
                <Check size={14} className={cn("shrink-0", option.value === value ? "opacity-100" : "opacity-0")} />
                <span className="grid min-w-0 flex-1">
                  <span className="truncate">{option.label}</span>
                  {option.description && <span className="truncate text-xs text-[var(--dim)]">{option.description}</span>}
                </span>
                {option.badges && <span className="flex shrink-0 items-center gap-1">{option.badges}</span>}
              </div>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
