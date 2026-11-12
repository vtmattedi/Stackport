import * as React from "react"

import { cn } from "@/lib/utils"
import { Hint } from "./text"

/**
 * A label, its control, and what to say about it. `hint` explains; `error` replaces the hint when something is wrong.
 * Pass the control's id as `htmlFor` so clicking the label focuses it.
 */
function Field({ label, hint, error, htmlFor, optional, className, children }: {
  label: React.ReactNode
  hint?: React.ReactNode
  error?: React.ReactNode
  htmlFor?: string
  optional?: boolean
  className?: string
  children: React.ReactNode
}) {
  return (
    <div data-slot="field" className={cn("grid min-w-0 gap-1.5", className)}>
      <label htmlFor={htmlFor} className="flex items-baseline gap-1.5 text-xs font-medium text-[var(--dim)]">
        {label}
        {optional && <span className="font-normal opacity-80">(optional)</span>}
      </label>
      {children}
      {error ? <Hint className="text-destructive">{error}</Hint> : hint ? <Hint>{hint}</Hint> : null}
    </div>
  )
}

/** A checkbox, switch or radio with the sentence that goes with it; the whole row is the click target. */
function CheckRow({ control, title, hint, htmlFor, className }: {
  control: React.ReactNode
  title: React.ReactNode
  hint?: React.ReactNode
  htmlFor?: string
  className?: string
}) {
  return (
    <label htmlFor={htmlFor} className={cn("flex cursor-pointer items-start gap-2.5 text-[13px] leading-snug", className)}>
      <span className="mt-0.5 flex shrink-0">{control}</span>
      <span className="grid gap-0.5">
        <span>{title}</span>
        {hint && <span className="text-xs leading-relaxed text-[var(--dim)]">{hint}</span>}
      </span>
    </label>
  )
}

export { Field, CheckRow }
