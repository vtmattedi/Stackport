import { useEffect, useState } from "react";
import { FileText, Loader, X } from "lucide-react";
import { Button } from "./ui/button";
import { api, ApiError } from "../api/client";

interface ComposeFileDialogProps {
  projectId: number;
  projectName: string;
  onClose: () => void;
}

export function ComposeFileDialog({ projectId, projectName, onClose }: ComposeFileDialogProps) {
  const [fileName, setFileName] = useState("");
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    api.getProjectComposeFileContent(projectId)
      .then((result) => {
        if (cancelled) return;
        setFileName(result.fileName);
        setContent(result.content);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "Failed to load compose file");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="confirm-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="shell-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`docker-compose.yml — ${projectName}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="shell-header">
          <FileText size={14} />
          <span className="shell-header-title mono">{fileName || "docker-compose.yml"}</span>
          {loading && <Loader size={12} className="spin" />}
          <Button type="button" variant="ghost" size="icon-xs" onClick={onClose} title="Close" aria-label="Close">
            <X size={12} />
          </Button>
        </div>
        <div style={{ minHeight: 0, overflow: "auto", background: "var(--bg)" }}>
          {error ? (
            <div className="alert alert-error" style={{ margin: 12 }}>{error}</div>
          ) : (
            <pre className="output-block mono" style={{ margin: 0, maxHeight: "none", border: "none", borderRadius: 0 }}>
              {content ?? (loading ? "Loading..." : "")}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
