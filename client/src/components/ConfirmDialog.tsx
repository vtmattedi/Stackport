import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "./ui/button";

interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  /** For irreversible actions: the confirm button stays disabled until this exact text
   *  (usually the project or service name) is typed. */
  requireText?: string;
}

interface ConfirmState extends Required<Omit<ConfirmOptions, "requireText">> {
  requireText: string | null;
}

type Resolver = (value: boolean) => void;

const ConfirmContext = createContext<((options: ConfirmOptions) => Promise<boolean>) | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ConfirmState | null>(null);
  const [typed, setTyped] = useState("");
  const resolverRef = useRef<Resolver | null>(null);

  const confirm = useCallback((options: ConfirmOptions) => {
    setState({
      title: options.title,
      description: options.description ?? "",
      confirmLabel: options.confirmLabel ?? "Confirm",
      cancelLabel: options.cancelLabel ?? "Cancel",
      destructive: options.destructive ?? false,
      requireText: options.requireText ?? null,
    });
    setTyped("");
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  function close(value: boolean) {
    resolverRef.current?.(value);
    resolverRef.current = null;
    setState(null);
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {state && (
        <div className="confirm-backdrop" role="presentation" onMouseDown={() => close(false)}>
          <div className="confirm-panel" role="dialog" aria-modal="true" aria-label={state.title} onMouseDown={(event) => event.stopPropagation()}>
            <div className="confirm-icon">
              <AlertTriangle size={18} />
            </div>
            <div className="confirm-copy">
              <h2>{state.title}</h2>
              {state.description && <p>{state.description}</p>}
              {state.requireText !== null && (
                <label className="confirm-require">
                  <span>Type <strong className="mono">{state.requireText}</strong> to confirm</span>
                  <input
                    type="text"
                    autoFocus
                    autoComplete="off"
                    spellCheck={false}
                    value={typed}
                    onChange={(event) => setTyped(event.target.value)}
                    onKeyDown={(event) => { if (event.key === "Enter" && typed === state.requireText) close(true); }}
                    aria-label={`Type ${state.requireText} to confirm`}
                  />
                </label>
              )}
            </div>
            <div className="confirm-actions">
              <Button type="button" variant="outline" size="sm" onClick={() => close(false)}>
                {state.cancelLabel}
              </Button>
              <Button
                type="button"
                variant={state.destructive ? "outline" : "default"}
                size="sm"
                className={state.destructive ? "confirm-danger" : undefined}
                disabled={state.requireText !== null && typed !== state.requireText}
                onClick={() => close(true)}
              >
                {state.confirmLabel}
              </Button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error("useConfirm must be used inside ConfirmProvider");
  return confirm;
}
