import { Search, X } from "lucide-react";
import { cn } from "../lib/utils";

export interface FilterOption<T extends string> {
  value: T;
  label: string;
  /** How many items the filter would show; chips with none are dimmed but still pressable. */
  count?: number;
}

/**
 * A search box and a row of filter chips for a list. The list owns the state and does the filtering; this is only the controls, so every
 * list (stacks, routes, certificates) looks and behaves the same.
 */
export function ListFilter<T extends string>({ query, onQueryChange, placeholder, label, options, value, onValueChange, className }: {
  query: string;
  onQueryChange: (query: string) => void;
  placeholder: string;
  /** The accessible name of the search box and of the chip group. */
  label: string;
  options: FilterOption<T>[];
  value: T;
  onValueChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-2", className)}>
      <div className="relative min-w-[200px] flex-1 basis-60">
        <Search size={13} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-[var(--dim)]" />
        <input
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={placeholder}
          aria-label={`Search ${label}`}
          className="h-9 w-full rounded-md border border-input bg-transparent pr-8 pl-8 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30 [&::-webkit-search-cancel-button]:hidden"
        />
        {query && (
          <button type="button" className="absolute top-1/2 right-2 -translate-y-1/2 text-[var(--dim)] hover:text-foreground" onClick={() => onQueryChange("")} aria-label="Clear search">
            <X size={13} />
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={`Filter ${label}`}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={value === option.value}
            onClick={() => onValueChange(option.value)}
            className={cn(
              "rounded-full border border-border px-3 py-1 text-xs text-[var(--dim)] transition-colors hover:text-foreground",
              "aria-pressed:border-primary aria-pressed:bg-primary/15 aria-pressed:text-foreground",
              option.count === 0 && value !== option.value && "opacity-50",
            )}
          >
            {option.label}{option.count !== undefined && <span className="ml-1.5 opacity-70">{option.count}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
