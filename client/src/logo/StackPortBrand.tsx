import { cn } from "../lib/utils";
import { StackPortIcon } from "./stackportIcon";

type StackPortWordmarkProps = {
  className?: string;
  stackClassName?: string;
  portClassName?: string;
};

type StackPortBrandProps = {
  className?: string;
  iconClassName?: string;
  wordmarkClassName?: string;
  iconSize?: number | string;
  showWordmark?: boolean;
  title?: string;
};

export function StackPortWordmark({
  className,
  stackClassName,
  portClassName,
}: StackPortWordmarkProps) {
  return (
    <span className={cn("stackport-wordmark", className)} aria-label="STACKPORT">
      <span aria-hidden="true" className={cn("stackport-wordmark__stack", stackClassName)}
        style={{ color: "var(--brand)" }}
      >
        STACK
      </span>
      <span aria-hidden="true" className={cn("stackport-wordmark__port", portClassName)}
        style={{ color: "var(--stackport-port-color)" }}
      >
        PORT
      </span>
    </span>
  );
}

export function StackPortBrand({
  className,
  iconClassName,
  wordmarkClassName,
  iconSize = 24,
  showWordmark = true,
  title = "STACKPORT",
}: StackPortBrandProps) {
  return (
    <span className={cn("stackport-brand", className)} title={title}>
      <StackPortIcon
        className={cn("stackport-brand__icon", iconClassName)}
        width={iconSize}
        height={iconSize}
        aria-hidden={showWordmark ? true : undefined}
        aria-label={showWordmark ? undefined : "STACKPORT logo"}
        role={showWordmark ? undefined : "img"}
        focusable="false"
      />
      {showWordmark && <StackPortWordmark className={wordmarkClassName} />}
    </span>
  );
}
