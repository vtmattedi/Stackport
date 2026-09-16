import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Settings as SettingsIcon, KeyRound, Eye, EyeOff, Check, RefreshCw, Loader, GitPullRequestArrow, Boxes, FolderSearch, AlertCircle, Eraser } from "lucide-react";
import { api, ApiError } from "../api/client";
import type { AppVersionInfo, GlobalRealtimeEvent, ProjectRepoFolderScanResult } from "../api/types";
import { useSocket } from "../context/SocketContext";
import { useConfirm } from "../components/ConfirmDialog";
import { cn } from "../lib/utils";
import { notify } from "../lib/notify";
import styles from "./Settings.module.scss";


function scanMismatchCount(scan: ProjectRepoFolderScanResult): number {
  return scan.missingProjectFolders.length + scan.orphanFolders.length + scan.nameMismatches.length;
}

function folderStatusLabel(status: ProjectRepoFolderScanResult["folders"][number]["status"]): string {
  if (status === "name-mismatch") return "Name mismatch";
  if (status === "no-project") return "No project";
  if (status === "unparseable") return "Unknown folder";
  return "Matched";
}

export default function Settings() {
  const { subscribeGlobal, unsubscribeGlobal } = useSocket();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNext, setShowNext] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);
  const [versionInfo, setVersionInfo] = useState<AppVersionInfo | null>(null);
  const [updatingApp, setUpdatingApp] = useState(false);
  const [updatingFrontend, setUpdatingFrontend] = useState(false);
  const [updateError, setUpdateError] = useState("");
  const [updateSuccess, setUpdateSuccess] = useState("");
  const [updateOutput, setUpdateOutput] = useState("");

  const confirmDialog = useConfirm();
  const [repoScan, setRepoScan] = useState<ProjectRepoFolderScanResult | null>(null);
  const [scanError, setScanError] = useState("");
  const [scanning, setScanning] = useState(false);
  const [cleaningFolder, setCleaningFolder] = useState<string | null>(null);
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null);

  useEffect(() => {
    api.getVersion().then(setVersionInfo).catch(() => {});
  }, []);



  useEffect(() => {
    const appendOutput = (text: string) => {
      setUpdateOutput((prev) => `${prev}${text}`.slice(-120_000));
    };
    const handler = (event: GlobalRealtimeEvent) => {
      if (event.type !== "system:update") return;

      if (event.status === "started") {
        setUpdateError("");
        setUpdateSuccess("");
        setUpdateOutput(`${event.message}\n`);
        setUpdatingApp(event.updateMode === "full");
        setUpdatingFrontend(event.updateMode === "frontend");
        return;
      }

      if (event.status === "running") {
        appendOutput(event.output ?? event.message);
        return;
      }

      if (event.done) {
        appendOutput(`\n${event.message}\n`);
        setUpdatingApp(false);
        setUpdatingFrontend(false);
        if (event.status === "success") {
          setUpdateSuccess(event.updateMode === "frontend"
            ? "Frontend update completed. The service restart may briefly refresh this page."
            : "Update completed. The service restart may briefly refresh this page.");
          api.getVersion().then(setVersionInfo).catch(() => {});
        } else {
          setUpdateError(event.updateMode === "frontend"
            ? "Frontend update failed. Review the command output below."
            : "Update failed. Review the command output below.");
        }
      }
    };

    subscribeGlobal<GlobalRealtimeEvent>(handler);
    return () => unsubscribeGlobal<GlobalRealtimeEvent>(handler);
  }, [subscribeGlobal, unsubscribeGlobal]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(""); setSuccess(false);
    if (next !== confirm) { setError("New passwords do not match."); return; }
    if (next.length < 8) { setError("Password must be at least 8 characters."); return; }
    setLoading(true);
    try {
      await api.changePassword(current, next);
      setSuccess(true);
      setCurrent(""); setNext(""); setConfirm("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to change password");
    } finally {
      setLoading(false);
    }
  }



  // Container-mode self-update recreates the very container serving this page's
  // Socket.io connection, so the "success" system:update event it would normally
  // wait for may never arrive — the process delivering it is killed mid-flight.
  // Poll /health directly instead (same origin, unauthenticated, no DB dependency).
  async function waitForHealthy(maxWaitMs = 5 * 60_000, intervalMs = 3_000): Promise<boolean> {
    const deadline = Date.now() + maxWaitMs;
    // Give the old container a moment to actually start going down before the
    // first check — otherwise it just hits the still-running old process and
    // returns healthy before the swap has begun.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    while (Date.now() < deadline) {
      try {
        const res = await fetch("/health", { cache: "no-store" });
        if (res.ok) return true;
      } catch {
        // Connection refused/reset while the container swaps — expected, keep polling.
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return false;
  }

  async function runSelfUpdate() {
    setUpdatingApp(true);
    setUpdateError("");
    setUpdateSuccess("");
    setUpdateOutput("");
    try {
      await api.runSelfUpdate();
      {
        setUpdateOutput("Update started — the container will rebuild and restart shortly. Waiting for it to come back...\n");
        const healthy = await waitForHealthy();
        setUpdatingApp(false);
        if (healthy) {
          setUpdateSuccess("Update completed. The service restarted.");
          api.getVersion().then(setVersionInfo).catch(() => {});
        } else {
          setUpdateError("Timed out waiting for the service to come back after the update. Check the host directly.");
        }
        return;
      }
    } catch (err) {
      setUpdatingApp(false);
      setUpdateError(err instanceof ApiError ? err.message : "Failed to start update");
    }
  }

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



  function formatBuild(value: string | null | undefined) {
    if (!value) return "Not built yet";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
  }



  return (
    <>
      <main className="main">
        <h1 className="page-title"><SettingsIcon size={20} />Settings</h1>

        <div className="card">
          <div className="card-title"><Boxes size={13} />Version Control</div>
          {updateError && <div className="alert alert-error">{updateError}</div>}
          {updateSuccess && (
            <div className="alert alert-success">
              <Check size={14} />{updateSuccess}
            </div>
          )}
          <div className={styles.versionGrid}>
            <div className={styles.versionItem}>
              <span>Backend</span>
              <strong>{versionInfo?.backend.version ?? "-"}</strong>
              <small>{formatBuild(versionInfo?.backend.builtAt)}</small>
              {versionInfo?.backend.gitCommit && (
                <small>
                  {versionInfo.backend.gitBranch || "git"} @ {versionInfo.backend.gitCommit}
                  {versionInfo.backend.gitMessage && <span className="muted-text"> — {versionInfo.backend.gitMessage}</span>}
                </small>
              )}
            </div>
            <div className={styles.versionItem}>
              <span>Frontend</span>
              <strong>{versionInfo?.frontend.version ?? "-"}</strong>
              <small>{formatBuild(versionInfo?.frontend.builtAt)}</small>
              {versionInfo?.frontend.gitCommit && (
                <small>
                  {versionInfo.frontend.gitBranch || "git"} @ {versionInfo.frontend.gitCommit}
                  {versionInfo.frontend.gitMessage && <span className="muted-text"> — {versionInfo.frontend.gitMessage}</span>}
                </small>
              )}
            </div>
          </div>

          <div className="row-actions" style={{ marginTop: 14 }}>

            <button className="btn btn-primary" type="button" onClick={() => void runSelfUpdate()} disabled={updatingApp || updatingFrontend}>
              {updatingApp ? <Loader size={13} className="spin" /> : <GitPullRequestArrow size={13} />}
              Rebuild & restart
            </button>
          </div>
          {(
            <span className="hint" style={{ display: "block", marginTop: 8 }}>
              Rebuilds the stackport image from the checkout on the host and recreates the container. The connection will drop briefly during the restart.
            </span>
          )}

          {updateOutput && <pre className={styles.updateOutput}>{updateOutput}</pre>}
        </div>



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

        <div className="card" style={{ maxWidth: 480 }}>
          <div className="card-title"><KeyRound size={12} />Change Password</div>
          {error && <div className="alert alert-error">{error}</div>}
          {success && (
            <div className="alert alert-success">
              <Check size={14} />Password updated successfully.
            </div>
          )}
          <form onSubmit={handleSubmit} className={styles.settingsForm}>
            <div className="field">
              <label>Current password</label>
              <div className={styles.inputWithIcon}>
                <input
                  type={showCurrent ? "text" : "password"}
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                  required
                  autoComplete="current-password"
                />
                <button type="button" className={cn("btn-icon", styles.inputIconBtn)} onClick={() => setShowCurrent(!showCurrent)}>
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
                <button type="button" className={cn("btn-icon", styles.inputIconBtn)} onClick={() => setShowNext(!showNext)}>
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

            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? "Saving…" : "Update Password"}
            </button>
          </form>
        </div>

      </main>
    </>
  );
}
