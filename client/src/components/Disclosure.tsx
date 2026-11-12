import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { cn } from "../lib/utils";

/**
 * A section that opens and closes: a row with a chevron, a title and (optionally) a short summary that is still visible when it is closed,
 * then the content. This is what a native <details> was used for; it is keyboard-operable, styled like the rest, and can be controlled.
 * Put the thing people came for outside it, and the reference material (long lists, advanced options) inside.
 */
export function Disclosure({ title, meta, defaultOpen = false, open, onOpenChange, className, children }: {
  title: ReactNode;
  /** Shown to the right of the title, also when closed: a count, a state. */
  meta?: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  children: ReactNode;
}) {
  const [inner, setInner] = useState(defaultOpen);
  const controlled = open !== undefined;
  const isOpen = controlled ? open : inner;
  return (
    <Collapsible
      open={isOpen}
      onOpenChange={(next) => { if (!controlled) setInner(next); onOpenChange?.(next); }}
      className={cn("rounded-md border border-border", className)}
    >
      <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-2 rounded-md px-3 py-2.5 text-left text-[13px] font-medium outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50">
        <ChevronRight size={14} className="shrink-0 text-[var(--dim)] transition-transform group-data-[state=open]:rotate-90" />
        <span>{title}</span>
        {meta !== undefined && <span className="ml-auto text-xs font-normal text-[var(--dim)]">{meta}</span>}
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t border-border px-3 py-3">{children}</CollapsibleContent>
    </Collapsible>
  );
}
