import type { ReactNode } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { cn } from "../lib/utils";

const EMPTY_VALUE = "__stackport_empty_select_value__";

export interface AppSelectOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

interface AppSelectProps {
  value: string;
  onValueChange?: (value: string) => void;
  options: AppSelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
  size?: "sm" | "default";
}

interface ActionSelectProps extends AppSelectProps {
  action: ReactNode;
}

function toRadixValue(value: string): string {
  return value === "" ? EMPTY_VALUE : value;
}

function fromRadixValue(value: string): string {
  return value === EMPTY_VALUE ? "" : value;
}

export function AppSelect({
  value,
  onValueChange,
  options,
  placeholder = "Select",
  disabled,
  className,
  triggerClassName,
  size,
}: AppSelectProps) {
  return (
    <Select
      value={toRadixValue(value)}
      onValueChange={(nextValue) => onValueChange?.(fromRadixValue(nextValue))}
      disabled={disabled}
    >
      <SelectTrigger size={size} className={cn("app-select-trigger", triggerClassName, className)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent position="popper" align="start">
        {options.map((option) => (
          <SelectItem
            key={option.value || EMPTY_VALUE}
            value={toRadixValue(option.value)}
            disabled={option.disabled}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function ActionSelect({ action, className, ...props }: ActionSelectProps) {
  return (
    <div className={cn("app-action-select", className)}>
      <AppSelect {...props} />
      {action}
    </div>
  );
}
