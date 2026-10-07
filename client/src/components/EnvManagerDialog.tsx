import { useEffect, useMemo, useRef, useState } from "react";
import { ClipboardPaste, Copy, Eye, EyeOff, FileText, Loader, Plus, Save, Search, Trash2, Upload, WandSparkles, X } from "lucide-react";
import type { EnvVariable, ProjectEnvFile } from "../api/types";
import { api, ApiError } from "../api/client";
import { EMPTY_VARIABLE, normalizeEnvRelativePath, parseEnvText } from "../lib/env";
import { notify } from "../lib/notify";
import { cn } from "../lib/utils";
import { useConfirm } from "./ConfirmDialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import styles from "./EnvManagerDialog.module.scss";

type KeyFormat = "base64" | "base64url" | "hex";

interface PendingImport {
  sourceName: string;
  relativePath: string;
  variables: EnvVariable[];
}

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

function generateRandomValue(size: number, format: KeyFormat): string {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  if (format === "hex") return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  const base64 = btoa(binary);
  return format === "base64url" ? base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : base64;
}

function RandomValueButton({ onGenerate }: { onGenerate: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [size, setSize] = useState("32");
  const [format, setFormat] = useState<KeyFormat>("base64");
  const parsedSize = Number(size);
  const validSize = Number.isInteger(parsedSize) && parsedSize >= 1 && parsedSize <= 65536;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="icon-xs" title="Generate random value" aria-label="Generate random value">
          <WandSparkles size={13} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className={styles.generatorPopover}>
        <div className={styles.generatorTitle}>Generate with kg settings</div>
        <div className={styles.generatorGrid}>
          <div className="field">
            <label>Bytes</label>
            <Input type="number" min="1" max="65536" value={size} onChange={(event) => setSize(event.target.value)} />
          </div>
          <div className="field">
            <label>Format</label>
            <select
              className={styles.generatorSelect}
              value={format}
              onChange={(event) => setFormat(event.target.value as KeyFormat)}
            >
              <option value="base64">base64</option>
              <option value="base64url">base64url</option>
              <option value="hex">hex</option>
            </select>
          </div>
        </div>
        <Button
          type="button"
          size="xs"
          disabled={!validSize}
          onClick={() => {
            onGenerate(generateRandomValue(parsedSize, format));
            setOpen(false);
          }}
        >
          <WandSparkles size={12} /> Generate
        </Button>
      </PopoverContent>
    </Popover>
  );
}

export function EnvManagerDialog({ projectId, projectName, envFiles, onEnvFilesChange, onClose }: EnvManagerDialogProps) {
  const confirm = useConfirm();
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const firstFile = envFiles[0];
  const [editingEnvId, setEditingEnvId] = useState<number | null>(firstFile?.id ?? null);
  const [envPath, setEnvPath] = useState(firstFile?.relativePath ?? "");
  const [envVariables, setEnvVariables] = useState<EnvVariable[]>(editableVariables(firstFile));
  const [search, setSearch] = useState("");
  const [visibleValues, setVisibleValues] = useState<Set<number>>(() => new Set());
  const [envError, setEnvError] = useState("");
  const [savingEnv, setSavingEnv] = useState(false);
  const [importError, setImportError] = useState("");
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteError, setPasteError] = useState("");

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
  const hiddenFileCount = envFiles.length - visibleFiles.length;
  const visibleVariableEntries = envVariables
    .map((variable, index) => ({ variable, index }))
    .filter(({ variable }) => !normalizedSearch || (
      variable.key.toLowerCase().includes(normalizedSearch) || variable.value.toLowerCase().includes(normalizedSearch)
    ));
  const hiddenVariableCount = envVariables.length - visibleVariableEntries.length;

  function editEnvFile(envFile: ProjectEnvFile) {
    setEditingEnvId(envFile.id);
    setEnvPath(envFile.relativePath);
    setEnvVariables(editableVariables(envFile));
    setVisibleValues(new Set());
    setEnvError("");
    setImportError("");
    setPendingImport(null);
    setPasteOpen(false);
    setPasteText("");
    setPasteError("");
  }

  function beginNewEnvFile() {
    setEditingEnvId(null);
    setEnvPath(".env");
    setEnvVariables([{ ...EMPTY_VARIABLE }]);
    setSearch("");
    setVisibleValues(new Set());
    setEnvError("");
    setImportError("");
    setPendingImport(null);
    setPasteOpen(false);
    setPasteText("");
    setPasteError("");
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
      setImportError("");
      setPendingImport(null);
      setPasteOpen(false);
      setPasteText("");
      setPasteError("");
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

  async function prepareImportFile(file: File) {
    if (!(await confirmDiscardDraft())) return;
    const parsed = parseEnvText(await file.text());
    if (parsed.length === 0) {
      notify.error(new Error("No KEY=value pairs found in the selected file."), "Could not import env file");
      return;
    }
    const suggestedPath = file.name.endsWith(".env") ? file.name : ".env";
    setImportError("");
    setPendingImport({ sourceName: file.name, relativePath: suggestedPath, variables: parsed });
  }

  function applyPendingImport() {
    if (!pendingImport) return;
    const normalizedPath = normalizeEnvRelativePath(pendingImport.relativePath);
    if (!normalizedPath) {
      setImportError("Path must be a relative .env file and cannot contain ..");
      return;
    }
    setEditingEnvId(null);
    setEnvPath(normalizedPath);
    setEnvVariables(pendingImport.variables);
    setVisibleValues(new Set());
    setEnvError("");
    setSearch("");
    notify.success(`Parsed ${pendingImport.variables.length} variables from ${pendingImport.sourceName}.`);
    setPendingImport(null);
    setImportError("");
  }

  function applyPastedVariables() {
    const parsed = parseEnvText(pasteText);
    if (parsed.length === 0) {
      setPasteError("No KEY=value pairs found to parse.");
      return;
    }

    const next = envVariables
      .filter((variable) => variable.key.trim() || variable.value)
      .map((variable) => ({ ...variable, key: variable.key.trim() }));
    const indexByKey = new Map(next.map((variable, index) => [variable.key, index]));
    let added = 0;
    let updated = 0;

    for (const variable of parsed) {
      const existingIndex = indexByKey.get(variable.key);
      if (existingIndex === undefined) {
        indexByKey.set(variable.key, next.length);
        next.push(variable);
        added += 1;
      } else {
        next[existingIndex] = variable;
        updated += 1;
      }
    }

    setEnvVariables(next.length > 0 ? next : [{ ...EMPTY_VARIABLE }]);
    setSearch("");
    setVisibleValues(new Set());
    setPasteText("");
    setPasteError("");
    setPasteOpen(false);
    notify.success(`Parsed env content: ${added} added${updated ? `, ${updated} updated` : ""}.`);
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
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (pendingImport) {
        setPendingImport(null);
        return;
      }
      void requestClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  return (
    <div className="confirm-backdrop" role="presentation" onMouseDown={() => void requestClose()}>
      <section
        className={cn(styles.panel, dragActive && styles.panelDragActive)}
        role="dialog"
        aria-modal="true"
        aria-label={`Environment manager — ${projectName}`}
        onMouseDown={(event) => event.stopPropagation()}
        onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }}
        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDragActive(true); }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragActive(false);
          const file = event.dataTransfer.files[0];
          if (file) void prepareImportFile(file);
        }}
      >
        {dragActive && <div className={styles.dropOverlay}><Upload size={24} /> Drop an env file to import</div>}
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
              onClick={() => importInputRef.current?.click()}
            >
              <Upload size={12} /> Import
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => {
                setPasteError("");
                setPasteOpen((open) => !open);
              }}
            >
              <ClipboardPaste size={12} /> Parse
            </Button>
            <input
              ref={importInputRef}
              className={styles.hiddenFileInput}
              type="file"
              accept=".env,text/plain"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void prepareImportFile(file);
              }}
            />
          </div>
        </div>

        <div className={styles.workspace}>
          <aside className={styles.fileRail}>
            <div className={styles.railHeader}>
              <span>{normalizedSearch ? "Matches" : "Configured files"}</span>
              <span>{visibleFiles.length}{normalizedSearch && hiddenFileCount > 0 ? ` +${hiddenFileCount}` : ""}</span>
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
                    {normalizedSearch
                      ? `${match?.variableMatches.length ?? 0} matches${envFile.variables.length - (match?.variableMatches.length ?? 0) > 0 ? ` · +${envFile.variables.length - (match?.variableMatches.length ?? 0)} not matching` : ""}`
                      : `${envFile.variables.length} variables`}
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
              <Button type="button" variant="outline" size="xs" onClick={() => {
                setSearch("");
                setEnvVariables((variables) => [...variables, { ...EMPTY_VARIABLE }]);
              }}>
                <Plus size={12} /> Variable
              </Button>
            </div>

            {pasteOpen && (
              <div className={styles.pastePanel}>
                <div className={styles.pasteHeader}>
                  <div>
                    <strong>Paste env contents</strong>
                    <span>New keys are added; matching keys are updated.</span>
                  </div>
                  <Button type="button" variant="ghost" size="icon-xs" onClick={() => {
                    setPasteOpen(false);
                    setPasteError("");
                  }} title="Close parser" aria-label="Close parser">
                    <X size={12} />
                  </Button>
                </div>
                {pasteError && <div className="alert alert-error">{pasteError}</div>}
                <textarea
                  className={styles.pasteTextarea}
                  value={pasteText}
                  onChange={(event) => { setPasteText(event.target.value); setPasteError(""); }}
                  placeholder={"API_URL=https://example.com\nJWT_SECRET=..."}
                  autoFocus
                />
                <div className={styles.editorActions}>
                  <Button type="button" size="xs" onClick={applyPastedVariables} disabled={!pasteText.trim()}>
                    <ClipboardPaste size={12} /> Add parsed variables
                  </Button>
                </div>
              </div>
            )}

            <div className={styles.variableTable}>
              {normalizedSearch && (
                <div className={styles.variableMatchSummary}>
                  {visibleVariableEntries.length} matching{hiddenVariableCount > 0 ? ` · +${hiddenVariableCount} not matching` : ""}
                </div>
              )}
              <div className={styles.variableHeader}><span>Key</span><span>Value</span><span aria-hidden="true" /></div>
              {visibleVariableEntries.length === 0 && normalizedSearch && (
                <div className={styles.noVariableMatches}>No variables in this file match the search.</div>
              )}
              {visibleVariableEntries.map(({ variable, index }) => (
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
                    {!variable.value && <RandomValueButton onGenerate={(value) => updateEnvVariable(index, "value", value)} />}
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
        {pendingImport && (
          <div className={styles.importPromptBackdrop} role="presentation" onMouseDown={() => setPendingImport(null)}>
            <div className={styles.importPrompt} role="dialog" aria-modal="true" aria-label="Name imported env file" onMouseDown={(event) => event.stopPropagation()}>
              <div>
                <h3>Name imported env file</h3>
                <p>Parsed {pendingImport.variables.length} variables from <span className="mono">{pendingImport.sourceName}</span>.</p>
              </div>
              {importError && <div className="alert alert-error">{importError}</div>}
              <div className="field field-wide">
                <label>Relative .env path</label>
                <Input
                  type="text"
                  value={pendingImport.relativePath}
                  onChange={(event) => {
                    setImportError("");
                    setPendingImport((current) => current ? { ...current, relativePath: event.target.value } : null);
                  }}
                  placeholder="services/api/.env"
                  autoFocus
                />
              </div>
              <div className={styles.editorActions}>
                <Button type="button" variant="outline" size="xs" onClick={() => setPendingImport(null)}>Cancel</Button>
                <Button type="button" size="xs" onClick={applyPendingImport}>
                  <Upload size={12} /> Import parsed values
                </Button>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
