import { useEffect, useMemo, useState } from "react";
import { Copy, Eye, EyeOff, FileText, Loader, Plus, Save, Search, Trash2, Upload, X } from "lucide-react";
import type { EnvVariable, ProjectEnvFile } from "../api/types";
import { api, ApiError } from "../api/client";
import { EMPTY_VARIABLE, normalizeEnvRelativePath, parseEnvText } from "../lib/env";
import { notify } from "../lib/notify";
import { cn } from "../lib/utils";
import { useConfirm } from "./ConfirmDialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import styles from "./EnvManagerDialog.module.scss";

interface EnvManagerDialogProps {
  projectId: number;
  projectName: string;
  envFiles: ProjectEnvFile[];
  onEnvFilesChange: (files: ProjectEnvFile[]) => void;
  onClose: () => void;
}

function editableVariables(envFile: ProjectEnvFile | undefined): EnvVariable[] {
  return envFile?.variables.length ? envFile.variables.map((variable) => ({ ...variable })) : [{ ...EMPTY_VARIABLE }];
}

export function EnvManagerDialog({ projectId, projectName, envFiles, onEnvFilesChange, onClose }: EnvManagerDialogProps) {
  const confirm = useConfirm();
  const firstFile = envFiles[0];
  const [editingEnvId, setEditingEnvId] = useState<number | null>(firstFile?.id ?? null);
  const [envPath, setEnvPath] = useState(firstFile?.relativePath ?? "");
  const [envVariables, setEnvVariables] = useState<EnvVariable[]>(editableVariables(firstFile));
  const [search, setSearch] = useState("");
  const [visibleValues, setVisibleValues] = useState<Set<number>>(() => new Set());
  const [envError, setEnvError] = useState("");
  const [savingEnv, setSavingEnv] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importPath, setImportPath] = useState("");
  const [importText, setImportText] = useState("");
  const [importFileName, setImportFileName] = useState("");
  const [importError, setImportError] = useState("");

  const selectedEnvFile = editingEnvId == null ? undefined : envFiles.find((file) => file.id === editingEnvId);
  const filledEnvVariables = envVariables.filter((variable) => variable.key.trim() || variable.value);
  const envDraftChanged = selectedEnvFile
    ? envPath !== selectedEnvFile.relativePath || JSON.stringify(envVariables) !== JSON.stringify(editableVariables(selectedEnvFile))
    : !!envPath || filledEnvVariables.length > 0;

  const normalizedSearch = search.trim().toLowerCase();
  const searchMatches = useMemo(() => {
    if (!normalizedSearch) return [];
    return envFiles.flatMap((file) => {
      const pathMatches = file.relativePath.toLowerCase().includes(normalizedSearch);
      const variableMatches = file.variables.filter((variable) => (
        variable.key.toLowerCase().includes(normalizedSearch) || variable.value.toLowerCase().includes(normalizedSearch)
      ));
      if (!pathMatches && variableMatches.length === 0) return [];
      return [{ file, pathMatches, variableMatches }];
    });
  }, [envFiles, normalizedSearch]);
  const visibleFiles = normalizedSearch ? searchMatches.map((match) => match.file) : envFiles;
  const variableMatchCount = searchMatches.reduce((total, match) => total + match.variableMatches.length, 0);

  function closeImportPanel() {
    setImportOpen(false);
    setImportPath("");
    setImportText("");
    setImportFileName("");
    setImportError("");
  }

  function editEnvFile(envFile: ProjectEnvFile) {
    setEditingEnvId(envFile.id);
    setEnvPath(envFile.relativePath);
    setEnvVariables(editableVariables(envFile));
    setVisibleValues(new Set());
    setEnvError("");
    closeImportPanel();
  }

  function beginNewEnvFile() {
    setEditingEnvId(null);
    setEnvPath(".env");
    setEnvVariables([{ ...EMPTY_VARIABLE }]);
    setVisibleValues(new Set());
    setEnvError("");
    closeImportPanel();
  }

  async function confirmDiscardDraft(): Promise<boolean> {
    if (!envDraftChanged) return true;
    return confirm({
      title: "Discard unsaved env changes?",
      description: "Changes in the current env file have not been saved.",
      confirmLabel: "Discard",
      destructive: true,
    });
  }

  async function selectEnvFile(envFile: ProjectEnvFile) {
    if (envFile.id === editingEnvId) return;
    if (!(await confirmDiscardDraft())) return;
    editEnvFile(envFile);
  }

  async function startNewEnvFile() {
    if (!(await confirmDiscardDraft())) return;
    beginNewEnvFile();
  }

  function resetDraft() {
    if (selectedEnvFile) editEnvFile(selectedEnvFile);
    else {
      setEnvPath("");
      setEnvVariables([{ ...EMPTY_VARIABLE }]);
      setVisibleValues(new Set());
      setEnvError("");
      closeImportPanel();
    }
  }

  function updateEnvVariable(index: number, field: keyof EnvVariable, value: string) {
    setEnvVariables((variables) => variables.map((variable, itemIndex) => (
      itemIndex === index ? { ...variable, [field]: value } : variable
    )));
  }

  function removeEnvVariable(index: number) {
    setEnvVariables((variables) => variables.length === 1
      ? [{ ...EMPTY_VARIABLE }]
      : variables.filter((_variable, itemIndex) => itemIndex !== index));
    setVisibleValues(new Set());
  }

  function toggleValue(index: number) {
    setVisibleValues((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  async function copyValue(variable: EnvVariable) {
    try {
      await navigator.clipboard.writeText(variable.value);
      notify.success(`${variable.key || "Value"} copied.`);
    } catch {
      notify.error("Clipboard access was denied.", "Failed to copy value");
    }
  }

  async function readImportFile(file: File) {
    setImportFileName(file.name);
    setImportError("");
    if (!importPath && !envPath) setImportPath(file.name.endsWith(".env") ? file.name : ".env");
    setImportText(await file.text());
  }

  function applyEnvImport() {
    const normalizedPath = normalizeEnvRelativePath(importPath || envPath);
    if (!normalizedPath) {
      setImportError("Path must be a relative .env file and cannot contain ..");
      return;
    }
    const parsed = parseEnvText(importText);
    if (parsed.length === 0) {
      setImportError("No KEY=value pairs found to import");
      return;
    }
    setEnvPath(normalizedPath);
    setEnvVariables(parsed);
    setVisibleValues(new Set());
    setEnvError("");
    notify.success(`Imported ${parsed.length} variables from .env text.`);
    closeImportPanel();
  }

  async function saveEnvFile(event: React.FormEvent) {
    event.preventDefault();
    const variables = envVariables
      .map((variable) => ({ key: variable.key.trim(), value: variable.value }))
      .filter((variable) => variable.key || variable.value);

    setSavingEnv(true);
    setEnvError("");
    const toastId = notify.loading(editingEnvId ? "Saving env file..." : "Creating env file...");
    try {
      const payload = { relativePath: envPath, variables };
      const saved = editingEnvId
        ? await api.updateProjectEnvFile(projectId, editingEnvId, payload)
        : await api.createProjectEnvFile(projectId, payload);
      const nextFiles = editingEnvId
        ? envFiles.map((file) => file.id === saved.id ? saved : file)
        : [...envFiles, saved];
      onEnvFilesChange(nextFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath)));
      setEditingEnvId(saved.id);
      setEnvPath(saved.relativePath);
      setEnvVariables(editableVariables(saved));
      setVisibleValues(new Set());
      notify.success(`${saved.relativePath} saved.`, { id: toastId });
    } catch (error) {
      setEnvError(error instanceof ApiError ? error.message : "Failed to save env file");
      notify.error(error, "Failed to save env file", { id: toastId });
    } finally {
      setSavingEnv(false);
    }
  }

  async function deleteEnvFile(envFile: ProjectEnvFile) {
    const ok = await confirm({
      title: `Delete ${envFile.relativePath}?`,
      description: "This removes the saved .env configuration from this project.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    const toastId = notify.loading(`Deleting ${envFile.relativePath}...`);
    try {
      await api.deleteProjectEnvFile(projectId, envFile.id);
      const nextFiles = envFiles.filter((file) => file.id !== envFile.id);
      onEnvFilesChange(nextFiles);
      const next = nextFiles[0];
      setEditingEnvId(next?.id ?? null);
      setEnvPath(next?.relativePath ?? "");
      setEnvVariables(editableVariables(next));
      setVisibleValues(new Set());
      notify.success(`${envFile.relativePath} deleted.`, { id: toastId });
    } catch (error) {
      notify.error(error, "Failed to delete env file", { id: toastId });
    }
  }

  async function requestClose() {
    if (!(await confirmDiscardDraft())) return;
    onClose();
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") void requestClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  return (
    <div className="confirm-backdrop" role="presentation" onMouseDown={() => void requestClose()}>
      <section
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label={`Environment manager — ${projectName}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className={styles.header}>
          <div className={styles.heading}>
            <FileText size={16} />
            <div>
              <h2>Environment Manager</h2>
              <p>{projectName} · {envFiles.length} files · {envFiles.reduce((total, file) => total + file.variables.length, 0)} variables</p>
            </div>
          </div>
          <Button type="button" variant="ghost" size="icon-xs" onClick={() => void requestClose()} title="Close" aria-label="Close environment manager">
            <X size={14} />
          </Button>
        </header>

        <div className={styles.toolbar}>
          <label className={styles.searchBox}>
            <Search size={14} />
            <Input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search file paths, keys, and values"
              aria-label="Search all project environment files"
              autoFocus
            />
            {search && (
              <Button type="button" variant="ghost" size="icon-xs" onClick={() => setSearch("")} title="Clear search" aria-label="Clear search">
                <X size={12} />
              </Button>
            )}
          </label>
          {normalizedSearch && (
            <span className={styles.searchSummary}>{searchMatches.length} files · {variableMatchCount} variable matches</span>
          )}
          <div className={styles.toolbarActions}>
            <Button type="button" variant="outline" size="xs" onClick={() => void startNewEnvFile()}>
              <Plus size={12} /> New file
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => {
                if (!importOpen && !importPath) setImportPath(envPath || ".env");
                setImportOpen((open) => !open);
              }}
            >
              <Upload size={12} /> Import
            </Button>
          </div>
        </div>

        <div className={styles.workspace}>
          <aside className={styles.fileRail}>
            <div className={styles.railHeader}>
              <span>{normalizedSearch ? "Matches" : "Configured files"}</span>
              <span>{visibleFiles.length}</span>
            </div>
            {visibleFiles.length === 0 ? (
              <div className={styles.railEmpty}>{normalizedSearch ? "No matching env files or variables." : "No env files yet."}</div>
            ) : visibleFiles.map((envFile) => {
              const match = normalizedSearch ? searchMatches.find((item) => item.file.id === envFile.id) : undefined;
              return (
                <button
                  type="button"
                  className={cn(styles.fileButton, editingEnvId === envFile.id && styles.fileButtonActive)}
                  key={envFile.id}
                  onClick={() => void selectEnvFile(envFile)}
                >
                  <span className={styles.fileName}><FileText size={13} /><span>{envFile.relativePath}</span></span>
                  <span className={styles.fileMeta}>
                    {normalizedSearch ? `${match?.variableMatches.length ?? 0} matching variables` : `${envFile.variables.length} variables`}
                  </span>
                </button>
              );
            })}
          </aside>

          <form onSubmit={(event) => void saveEnvFile(event)} className={styles.editorPanel}>
            <div className={styles.editorTopbar}>
              <div>
                <div className={styles.editorTitle}>{selectedEnvFile ? selectedEnvFile.relativePath : "New env file"}</div>
                <div className="muted-text">{filledEnvVariables.length} populated variables {envDraftChanged ? "· Unsaved changes" : ""}</div>
              </div>
              {selectedEnvFile && (
                <Button type="button" variant="outline" size="xs" className={styles.deleteButton} onClick={() => void deleteEnvFile(selectedEnvFile)}>
                  <Trash2 size={12} /> Delete file
                </Button>
              )}
            </div>

            {envError && <div className="alert alert-error">{envError}</div>}

            <div className={styles.pathRow}>
              <div className="field field-wide">
                <label>Relative .env path</label>
                <Input type="text" placeholder="services/api/.env" value={envPath} onChange={(event) => setEnvPath(event.target.value)} required />
              </div>
              <Button type="button" variant="outline" size="xs" onClick={() => setEnvVariables((variables) => [...variables, { ...EMPTY_VARIABLE }])}>
                <Plus size={12} /> Variable
              </Button>
            </div>

            {importOpen && (
              <div className={styles.importPanel}>
                {importError && <div className="alert alert-error">{importError}</div>}
                <div className={styles.importGrid}>
                  <div className="field">
                    <label>Import path</label>
                    <Input type="text" placeholder="services/api/.env" value={importPath} onChange={(event) => setImportPath(event.target.value)} />
                  </div>
                  <label className={styles.dropZone} onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
                    event.preventDefault();
                    const file = event.dataTransfer.files[0];
                    if (file) void readImportFile(file);
                  }}>
                    <input type="file" accept=".env,text/plain" onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void readImportFile(file);
                    }} />
                    <Upload size={14} /> <span>{importFileName || "Drop .env"}</span>
                  </label>
                </div>
                <textarea
                  className={styles.importTextarea}
                  placeholder={"API_URL=https://example.com\nNODE_ENV=production"}
                  value={importText}
                  onChange={(event) => setImportText(event.target.value)}
                />
                <div className={styles.editorActions}>
                  <Button type="button" variant="ghost" size="xs" onClick={closeImportPanel}>Cancel</Button>
                  <Button type="button" size="xs" onClick={applyEnvImport} disabled={!importText.trim()}>Parse</Button>
                </div>
              </div>
            )}

            <div className={styles.variableTable}>
              <div className={styles.variableHeader}><span>Key</span><span>Value</span><span>Actions</span></div>
              {envVariables.map((variable, index) => (
                <div className={styles.variableRow} key={index}>
                  <Input type="text" placeholder="KEY" value={variable.key} onChange={(event) => updateEnvVariable(index, "key", event.target.value)} />
                  <div className={styles.valueField}>
                    <Input
                      type={visibleValues.has(index) ? "text" : "password"}
                      placeholder="value"
                      value={variable.value}
                      onChange={(event) => updateEnvVariable(index, "value", event.target.value)}
                    />
                    <Button type="button" variant="ghost" size="icon-xs" onClick={() => toggleValue(index)} title={visibleValues.has(index) ? "Hide value" : "Show value"} aria-label={visibleValues.has(index) ? `Hide ${variable.key || "value"}` : `Show ${variable.key || "value"}`}>
                      {visibleValues.has(index) ? <EyeOff size={13} /> : <Eye size={13} />}
                    </Button>
                    <Button type="button" variant="ghost" size="icon-xs" onClick={() => void copyValue(variable)} disabled={!variable.value} title="Copy value" aria-label={`Copy ${variable.key || "value"}`}>
                      <Copy size={13} />
                    </Button>
                  </div>
                  <Button type="button" variant="ghost" size="icon-xs" onClick={() => removeEnvVariable(index)} title="Remove variable" aria-label={`Remove ${variable.key || "variable"}`}>
                    <Trash2 size={13} />
                  </Button>
                </div>
              ))}
            </div>

            <footer className={styles.editorActions}>
              <Button type="button" variant="outline" size="xs" onClick={resetDraft} disabled={!envDraftChanged}>
                <X size={12} /> Reset
              </Button>
              <Button type="submit" size="xs" disabled={savingEnv || !envPath.trim()}>
                {savingEnv ? <Loader size={12} className="spin" /> : <Save size={12} />}
                {editingEnvId ? "Save file" : "Create file"}
              </Button>
            </footer>
          </form>
        </div>
      </section>
    </div>
  );
}
