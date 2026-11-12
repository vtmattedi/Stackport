import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * Vertical (or, with `row`, horizontal) spacing between children. The global reset gives every element a zero margin, so
 * paragraphs, hints, buttons and tables that sit next to each other touch unless something puts space between them: this is that something.
 * gap is in 4px steps: 2 = 8px, 3 = 12px (the default), 4 = 16px, 6 = 24px.
 */
const stackVariants = cva("", {
  variants: {
    gap: { 1: "gap-1", 2: "gap-2", 3: "gap-3", 4: "gap-4", 6: "gap-6" },
    row: { true: "flex flex-row", false: "flex flex-col" },
    wrap: { true: "flex-wrap", false: "" },
    align: { start: "items-start", center: "items-center", end: "items-end", stretch: "" },
  },
  defaultVariants: { gap: 3, row: false, wrap: false, align: "stretch" },
})

function Stack({ className, gap, row, wrap, align, ...props }: React.ComponentProps<"div"> & VariantProps<typeof stackVariants>) {
  return <div data-slot="stack" className={cn(stackVariants({ gap, row, wrap, align }), className)} {...props} />
}

export { Stack }
