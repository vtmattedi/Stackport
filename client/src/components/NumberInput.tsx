import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "../lib/utils";
import styles from "./NumberInput.module.scss";

interface NumberInputProps {
  value: number | null;
  onValueChange: (value: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Short unit shown inside the field, e.g. "GB". */
  suffix?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
  "aria-label"?: string;
}

const HOLD_DELAY_MS = 380;
const HOLD_INTERVAL_MS = 60;

function decimalsOf(step: number): number {
  const text = String(step);
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : text.length - dot - 1;
}

function parseText(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (trimmed === "-" || trimmed === "." || trimmed === "-.") return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function sameNumber(a: number | null | undefined, b: number | null): boolean {
  if (a == null || b == null) return a === b;
  return Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-9);
}

/**
 * Numeric field with its own stepper. The text is kept as a draft while typing,
 * so partial input like "2." survives re-renders; it is clamped to min/max and
 * rounded to the step's precision on blur.
 */
export function NumberInput({
  value,
  onValueChange,
  min,
  max,
  step = 1,
  suffix,
  placeholder,
  disabled,
  className,
  id,
  "aria-label": ariaLabel,
}: NumberInputProps) {
  const decimals = decimalsOf(step);
  const format = (next: number | null) => (next == null ? "" : next.toFixed(decimals));
  const [text, setText] = useState(() => format(value));
  const inputRef = useRef<HTMLInputElement | null>(null);
  const holdTimer = useRef<number | null>(null);
  const latest = useRef(value);
  latest.current = value;

  // Follow outside changes without clobbering a draft that already means the same number.
  useEffect(() => {
    setText((current) => (sameNumber(parseText(current), value) ? current : format(value)));
  }, [value, decimals]);

  useEffect(() => () => stopHold(), []);

  const allowNegative = min === undefined || min < 0;
  const pattern = new RegExp(`^${allowNegative ? "-?" : ""}\\d*${decimals > 0 ? `(\\.\\d{0,${decimals}})?` : ""}$`);

  function clamp(next: number): number {
    let result = Number(next.toFixed(decimals));
    if (min !== undefined) result = Math.max(min, result);
    if (max !== undefined) result = Math.min(max, result);
    return result;
  }

  function commit(next: number | null) {
    setText(format(next));
    if (!sameNumber(next, latest.current)) onValueChange(next);
    latest.current = next;
  }

  function stepBy(direction: 1 | -1, multiplier = 1) {
    const base = latest.current;
    commit(clamp(base == null ? (min ?? 0) : base + direction * step * multiplier));
  }

  function stopHold() {
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
    holdTimer.current = null;
  }

  function startHold(direction: 1 | -1, event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || disabled) return;
    event.preventDefault();
    inputRef.current?.focus();
    stepBy(direction);
    const repeat = (delay: number) => {
      holdTimer.current = window.setTimeout(() => {
        stepBy(direction);
        repeat(HOLD_INTERVAL_MS);
      }, delay);
    };
    stopHold();
    repeat(HOLD_DELAY_MS);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const big = event.shiftKey ? 10 : 1;
    if (event.key === "ArrowUp") { event.preventDefault(); stepBy(1, big); }
    else if (event.key === "ArrowDown") { event.preventDefault(); stepBy(-1, big); }
    else if (event.key === "PageUp") { event.preventDefault(); stepBy(1, 10); }
    else if (event.key === "PageDown") { event.preventDefault(); stepBy(-1, 10); }
    else if (event.key === "Home" && min !== undefined) { event.preventDefault(); commit(min); }
    else if (event.key === "End" && max !== undefined) { event.preventDefault(); commit(max); }
    else if (event.key === "Enter") commit(normalizedDraft());
  }

  function normalizedDraft(): number | null {
    const parsed = parseText(text);
    if (parsed === undefined) return latest.current;
    return parsed === null ? null : clamp(parsed);
  }

  const atMin = value != null && min !== undefined && value <= min;
  const atMax = value != null && max !== undefined && value >= max;

  return (
    <div className={cn(styles.root, disabled && styles.disabled, className)} data-slot="number-input">
      <input
        ref={inputRef}
        id={id}
        className={styles.control}
        type="text"
        inputMode={decimals > 0 ? "decimal" : "numeric"}
        autoComplete="off"
        role="spinbutton"
        aria-label={ariaLabel}
        aria-valuenow={value ?? undefined}
        aria-valuemin={min}
        aria-valuemax={max}
        placeholder={placeholder}
        disabled={disabled}
        value={text}
        onChange={(event) => {
          const nextText = event.target.value.replace(",", ".");
          if (!pattern.test(nextText)) return;
          setText(nextText);
          const parsed = parseText(nextText);
          if (parsed !== undefined && !sameNumber(parsed, latest.current)) {
            onValueChange(parsed);
            latest.current = parsed;
          }
        }}
        onBlur={() => commit(normalizedDraft())}
        onKeyDown={handleKeyDown}
      />
      {suffix && <span className={styles.suffix}>{suffix}</span>}
      <div className={styles.stepper}>
        <button
          type="button"
          tabIndex={-1}
          aria-label="Increase"
          disabled={disabled || atMax}
          onPointerDown={(event) => startHold(1, event)}
          onPointerUp={stopHold}
          onPointerLeave={stopHold}
          onPointerCancel={stopHold}
        >
          <ChevronUp size={12} />
        </button>
        <button
          type="button"
          tabIndex={-1}
          aria-label="Decrease"
          disabled={disabled || atMin}
          onPointerDown={(event) => startHold(-1, event)}
          onPointerUp={stopHold}
          onPointerLeave={stopHold}
          onPointerCancel={stopHold}
        >
          <ChevronDown size={12} />
        </button>
      </div>
    </div>
  );
}
