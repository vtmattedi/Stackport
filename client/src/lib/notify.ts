import type { ReactNode } from "react";
import { toast, type ExternalToast } from "sonner";

type ToastId = string | number;

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export const notify = {
  // Widened to ReactNode (not just string) so a running build/deploy can render a
  // live progress bar + elapsed timer in place of plain "X started..." text —
  // sonner itself already supports arbitrary content here.
  loading(message: ReactNode, options?: ExternalToast): ToastId {
    return toast.loading(message, options);
  },

  success(message: string, options?: ExternalToast) {
    return toast.success(message, { duration: 4200, ...options });
  },

  error(err: unknown, fallback: string, options?: ExternalToast) {
    return toast.error(errorMessage(err, fallback), { duration: 7000, ...options });
  },

  dismiss(id?: ToastId) {
    toast.dismiss(id);
  },
};
