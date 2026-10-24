import { useState } from "react";
import { Link } from "react-router-dom";
import { Check, RefreshCw, Loader, FolderSearch, AlertCircle, Eraser } from "lucide-react";
import { api, ApiError } from "../../api/client";
import type { ProjectRepoFolderScanResult } from "../../api/types";
import { useConfirm } from "../../components/ConfirmDialog";
import { notify } from "../../lib/notify";

function scanMismatchCount(scan: ProjectRepoFolderScanResult): number {
  return scan.missingProjectFolders.length + scan.orphanFolders.length + scan.nameMismatches.length;
}

function folderStatusLabel(status: ProjectRepoFolderScanResult["folders"][number]["status"]): string {
  if (status === "name-mismatch") return "Name mismatch";
  if (status === "no-project") return "No project";
  if (status === "unparseable") return "Unknown folder";
  return "Matched";
}

/** Repo folder scan: deploy-root folders that don't line up with saved projects. */
export default function MaintenanceSection() {
  const confirmDialog = useConfirm();
  const [repoScan, setRepoScan] = useState<ProjectRepoFolderScanResult | null>(null);
  const [scanError, setScanError] = useState("");
  const [scanning, setScanning] = useState(false);
  const [cleaningFolder, setCleaningFolder] = useState<string | null>(null);
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null);

  async function handleRepoScan() {
    setScanError("");
    setScanning(true);
    try {
      const result = await api.scanProjectRepoFolders();
      setRepoScan(result);
      const mismatches = scanMismatchCount(result);
      if (mismatches === 0) {
        notify.success("Repo folders match the projects table.");
      } else {
        notify.error(new Error(`${mismatches} repo folder mismatch${mismatches === 1 ? "" : "es"} found.`), "Repo folder scan found mismatches");
      }
    } catch (err) {
      setScanError(err instanceof ApiError ? err.message : "Failed to scan repo folders");
    } finally {
      setScanning(false);
    }
  }

  async function handleCleanupOrphanFolder(folderPath: string, folderName: string, hasCompose: boolean) {
    const ok = await confirmDialog({
      title: `Delete "${folderName}"?`,
      description: hasCompose
        ? "This will run docker compose down (removing volumes and images), then permanently delete the folder."
        : "This will permanently delete the folder and all its contents.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    setCleaningFolder(folderPath);
    const toastId = notify.loading(`Cleaning up ${folderName}...`);
    try {
      const result = await api.cleanupOrphanFolder(folderPath);
      if (result.ok) {
        notify.success(`${folderName} cleaned up.`, { id: toastId });
        const updated = await api.scanProjectRepoFolders();
        setRepoScan(updated);
      } else {
        notify.error(new Error(result.log || "Cleanup failed"), `Failed to clean up ${folderName}`, { id: toastId });
      }
    } catch (err) {
      notify.error(err, `Failed to clean up ${folderName}`, { id: toastId });
    } finally {
      setCleaningFolder(null);
    }
  }

  async function handleRenameMismatchFolder(projectId: number, folder: string, expectedFolder: string) {
    const ok = await confirmDialog({
      title: `Rename "${folder}" to "${expectedFolder}"?`,
      description: "Stops any containers still running under the old folder's project name, then renames the folder on disk to match the project. Redeploy afterward to bring it back up under the new name.",
      confirmLabel: "Rename",
    });
    if (!ok) return;
    setRenamingFolder(folder);
    const toastId = notify.loading(`Renaming ${folder}...`);
    try {
      const result = await api.renameRepoFolder(projectId, folder);
      if (result.ok) {
        notify.success(result.message || `Renamed to ${expectedFolder}.`, { id: toastId });
        const updated = await api.scanProjectRepoFolders();
        setRepoScan(updated);
      } else {
        notify.error(new Error(result.message || "Rename failed"), `Failed to rename ${folder}`, { id: toastId });
      }
    } catch (err) {
      notify.error(err, `Failed to rename ${folder}`, { id: toastId });
    } finally {
      setRenamingFolder(null);
    }
  }

  return (
        <div className="card">
          <div className="card-title">
            <FolderSearch size={12} />Repo Folder Scan
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ marginLeft: "auto" }}
              onClick={() => void handleRepoScan()}
              disabled={scanning}
            >
              {scanning ? <Loader size={13} className="spin" /> : <FolderSearch size={13} />}
              Scan repos
            </button>
          </div>
          {scanError && <div className="alert alert-error">{scanError}</div>}
          {repoScan ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div className={scanMismatchCount(repoScan) === 0 ? "alert alert-success" : "alert alert-error"} style={{ marginBottom: 0 }}>
                {scanMismatchCount(repoScan) === 0 ? <Check size={14} /> : <AlertCircle size={14} />}
                <span>
                  {scanMismatchCount(repoScan) === 0
                    ? "Repo folders match the projects table."
                    : `${scanMismatchCount(repoScan)} mismatch${scanMismatchCount(repoScan) === 1 ? "" : "es"} found.`}
                </span>
              </div>
              <div className="muted-text">
                Deploy root: <span className="mono">{repoScan.deployRoot}</span>
              </div>
              {repoScan.missingProjectFolders.length > 0 && (
                <div>
                  <div className="card-title" style={{ marginBottom: 8 }}>Projects missing expected folder</div>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Project</th>
                          <th>Repo</th>
                          <th>Expected folder</th>
                        </tr>
                      </thead>
                      <tbody>
                        {repoScan.missingProjectFolders.map((item) => (
                          <tr key={item.projectId}>
                            <td><Link className="ext-link" to={`/projects/${item.projectId}`}>{item.name}</Link></td>
                            <td>{item.githubRepo ? <span className="mono">{item.githubRepo}</span> : <span className="muted-text">Not set</span>}</td>
                            <td><span className="mono">{item.expectedFolder}</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              {repoScan.orphanFolders.length > 0 && (
                <div>
                  <div className="card-title" style={{ marginBottom: 8 }}>Folders without a project</div>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Folder</th>
                          <th>Status</th>
                          <th>Path</th>
                          <th style={{ width: 1 }} />
                        </tr>
                      </thead>
                      <tbody>
                        {repoScan.orphanFolders.map((item) => (
                          <tr key={item.path}>
                            <td><span className="mono">{item.folder}</span></td>
                            <td>{folderStatusLabel(item.status)}</td>
                            <td><span className="mono">{item.path}</span></td>
                            <td>
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm btn-danger"
                                title={item.hasCompose ? "Compose down, remove images/volumes, delete folder" : "Delete folder"}
                                disabled={cleaningFolder !== null}
                                onClick={() => void handleCleanupOrphanFolder(item.path, item.folder, item.hasCompose)}
                              >
                                {cleaningFolder === item.path ? <Loader size={12} className="spin" /> : <Eraser size={12} />}
                                Clean up
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              {repoScan.nameMismatches.length > 0 && (
                <div>
                  <div className="card-title" style={{ marginBottom: 8 }}>Folder name mismatches</div>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Folder</th>
                          <th>Project</th>
                          <th>Expected</th>
                          <th style={{ width: 1 }} />
                        </tr>
                      </thead>
                      <tbody>
                        {repoScan.nameMismatches.map((item) => (
                          <tr key={item.path}>
                            <td><span className="mono">{item.folder}</span></td>
                            <td>{item.projectId ? <Link className="ext-link" to={`/projects/${item.projectId}`}>{item.projectName}</Link> : <span className="muted-text">Not found</span>}</td>
                            <td><span className="mono">{item.expectedFolder}</span></td>
                            <td>
                              {item.projectId && item.expectedFolder && (
                                <button
                                  type="button"
                                  className="btn btn-ghost btn-sm"
                                  title={`Rename to ${item.expectedFolder}`}
                                  disabled={renamingFolder !== null}
                                  onClick={() => void handleRenameMismatchFolder(item.projectId as number, item.folder, item.expectedFolder as string)}
                                >
                                  {renamingFolder === item.folder ? <Loader size={12} className="spin" /> : <RefreshCw size={12} />}
                                  Fix
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="muted-text">Scan the deploy root for folders that do not line up with saved projects.</div>
          )}
        </div>
  );
}
