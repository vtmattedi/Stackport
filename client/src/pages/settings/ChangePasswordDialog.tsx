import { useEffect, useState } from "react";
import { KeyRound, Eye, EyeOff, Loader, X } from "lucide-react";
import { api, ApiError } from "../../api/client";
import { Button } from "../../components/ui/button";
import { notify } from "../../lib/notify";
import { cn } from "../../lib/utils";
import styles from "../Settings.module.scss";

/** Modal form for the admin password, opened from Settings > General. */
export function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNext, setShowNext] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !loading) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [loading, onClose]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (next !== confirm) { setError("New passwords do not match."); return; }
    if (next.length < 8) { setError("Password must be at least 8 characters."); return; }
    setLoading(true);
    try {
      await api.changePassword(current, next);
      notify.success("Password updated.");
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to change password");
      setLoading(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={() => { if (!loading) onClose(); }}>
      <form
        className={cn("modal-panel", styles.passwordModal)}
        role="dialog"
        aria-modal="true"
        aria-label="Change password"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => void handleSubmit(event)}
      >
        <div className={styles.modalHeader}>
          <div>
            <h2><KeyRound size={14} />Change password</h2>
            <p>Signs in to this Stackport. Use at least 8 characters.</p>
          </div>
          <Button type="button" variant="ghost" size="icon-xs" onClick={onClose} disabled={loading} title="Close" aria-label="Close">
            <X size={12} />
          </Button>
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        <div className={styles.settingsForm}>
          <div className="field">
            <label>Current password</label>
            <div className={styles.inputWithIcon}>
              <input
                type={showCurrent ? "text" : "password"}
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                required
                autoFocus
                autoComplete="current-password"
              />
              <button type="button" className={cn("btn-icon", styles.inputIconBtn)} onClick={() => setShowCurrent(!showCurrent)} aria-label={showCurrent ? "Hide password" : "Show password"}>
                {showCurrent ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>

          <div className="field">
            <label>New password</label>
            <div className={styles.inputWithIcon}>
              <input
                type={showNext ? "text" : "password"}
                value={next}
                onChange={(e) => setNext(e.target.value)}
                required
                autoComplete="new-password"
              />
              <button type="button" className={cn("btn-icon", styles.inputIconBtn)} onClick={() => setShowNext(!showNext)} aria-label={showNext ? "Hide password" : "Show password"}>
                {showNext ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>

          <div className="field">
            <label>Confirm new password</label>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              autoComplete="new-password"
            />
          </div>
        </div>

        <div className={styles.modalActions}>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={loading}>Cancel</Button>
          <Button type="submit" size="sm" disabled={loading || !current || !next || !confirm}>
            {loading && <Loader size={13} className="spin" />}
            Update password
          </Button>
        </div>
      </form>
    </div>
  );
}
