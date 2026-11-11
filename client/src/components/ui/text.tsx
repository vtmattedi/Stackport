import * as React from "react"

import { cn } from "@/lib/utils"

/** Running text. Lines stop at about 75 characters so a paragraph in a wide card stays readable. */
function Prose({ className, ...props }: React.ComponentProps<"p">) {
  return <p data-slot="prose" className={cn("max-w-[75ch] text-[13px] leading-relaxed", className)} {...props} />
}

/** Secondary text under a heading, a field or a button. 12px, the dimmed colour that still reads on the dark background. */
function Hint({ className, ...props }: React.ComponentProps<"p">) {
  return <p data-slot="hint" className={cn("max-w-[75ch] text-xs leading-relaxed text-[var(--dim)]", className)} {...props} />
}

export { Prose, Hint }
