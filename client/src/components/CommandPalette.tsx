import { useEffect, useMemo, useRef, useState, type ComponentType, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Dialog } from "radix-ui";
import {
  BarChart2, Box, FolderDot, Gauge, Globe, History, Layers, Rocket, ScrollText,
  Search, ShieldCheck, SlidersHorizontal,
} from "lucide-react";
import { useSystem } from "../context/SystemContext";
import { SETTINGS_SECTIONS } from "../pages/settings/SettingsLayout";
import { useDeployWithPreview } from "./RevisionPreview";
import styles from "./CommandPalette.module.scss";

const OPEN_EVENT = "stackport:command-palette";

/** Opens the palette from anywhere (the nav's Search buttons). */
export function openCommandPalette(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

interface Command {
  id: string;
  group: "Pages" | "Projects" | "Actions";
  label: string;
  hint?: string;
  icon: ComponentType<{ size?: number }>;
  /** Extra words that should match, e.g. the project's repo. */
  keywords?: string;
  run: () => void;
}

/** Higher is better; null means no match. Prefix beats word start beats substring
 *  beats letters in order. */
function score(command: Command, query: string): number | null {
  if (!query) return 0;
  const label = command.label.toLowerCase();
  const haystack = `${label} ${command.hint ?? ""} ${command.keywords ?? ""}`.toLowerCase();
  if (label.startsWith(query)) return 4;
  if (haystack.includes(` ${query}`) || haystack.includes(`/${query}`)) return 3;
  if (haystack.includes(query)) return 2;
  let at = 0;
  for (const ch of query) {
    at = haystack.indexOf(ch, at);
    if (at === -1) return null;
    at++;
  }
  return 1;
}

const HOST_SECTIONS = [
  { tab: "nginx", label: "Nginx", icon: Layers },
  { tab: "docker", label: "Docker", icon: Box },
  { tab: "certbot", label: "Certbot", icon: ShieldCheck },
  { tab: "hardware", label: "Hardware", icon: Gauge },
] as const;

const PROJECT_TABS = [
  { tab: "deploys", label: "deploys", icon: History },
  { tab: "domains", label: "domains", icon: Globe },
  { tab: "settings", label: "settings", icon: SlidersHorizontal },
] as const;

/** Cmd/Ctrl-K: jump to a page, project or project tab, or deploy a project. */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const { projects } = useSystem();
  const deployWithPreview = useDeployWithPreview();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((v) => !v);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);

  useEffect(() => {
    if (open) { setQuery(""); setActive(0); }
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const go = (to: string) => () => navigate(to);
    const list: Command[] = [];
    for (const project of projects ?? []) {
      const keywords = [project.githubRepo, project.groupName].filter(Boolean).join(" ");
      list.push({
        id: `project-${project.id}`, group: "Projects", label: project.name, hint: project.githubRepo ?? "upload",
        icon: FolderDot, keywords, run: go(`/projects/${project.id}/overview`),
      });
      for (const { tab, label, icon } of PROJECT_TABS) {
        list.push({
          id: `project-${project.id}-${tab}`, group: "Projects", label: `${project.name} ${label}`,
          icon, keywords, run: go(`/projects/${project.id}/${tab}`),
        });
      }
      if (project.githubRepo && !project.paused && project.autoDeployBranch) {
        list.push({
          id: `deploy-${project.id}`, group: "Actions", label: `Deploy ${project.name}`, hint: project.autoDeployBranch,
          icon: Rocket, keywords, run: () => {
            navigate(`/projects/${project.id}/deploys`);
            void deployWithPreview(project);
          },
        });
      }
    }
    list.push(
      { id: "projects", group: "Pages", label: "Projects", icon: FolderDot, run: go("/projects") },
      ...HOST_SECTIONS.map(({ tab, label, icon }): Command => ({
        id: `host-${tab}`, group: "Pages", label: `Host: ${label}`, icon, keywords: "system", run: go(`/host/${tab}`),
      })),
      { id: "logs", group: "Pages", label: "Logs", hint: "audit log", icon: ScrollText, run: go("/logs") },
      { id: "insights", group: "Pages", label: "Insights", icon: BarChart2, keywords: "metrics traffic", run: go("/insights") },
      ...SETTINGS_SECTIONS.map(({ path, label, icon }): Command => ({
        id: `settings-${path}`, group: "Pages", label: `Settings: ${label}`, icon, run: go(`/settings/${path}`),
      })),
    );
    return list;
  }, [projects, navigate, deployWithPreview]);

  const q = query.trim().toLowerCase();
  const results = useMemo(() => {
    const matched = commands
      .map((command, index) => ({ command, index, score: score(command, q) }))
      .filter((r): r is { command: Command; index: number; score: number } => r.score !== null);
    // Without a query, project tabs would bury everything else: show the main entries only.
    const shown = q ? matched : matched.filter((r) => !/^project-\d+-/.test(r.command.id));
    const sorted = shown.sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 50).map((r) => r.command);
    // One heading per group: groups in the order of their best match.
    const groups = [...new Set(sorted.map((c) => c.group))];
    return groups.flatMap((group) => sorted.filter((c) => c.group === group));
  }, [commands, q]);

  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function runCommand(command: Command | undefined) {
    if (!command) return;
    setOpen(false);
    command.run();
  }

  function onKeyDown(event: ReactKeyboardEvent) {
    if (event.key === "ArrowDown") { event.preventDefault(); setActive((i) => Math.min(i + 1, results.length - 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (event.key === "Enter") { event.preventDefault(); runCommand(results[active]); }
  }

  let lastGroup: string | null = null;
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.panel} aria-describedby={undefined} onKeyDown={onKeyDown}>
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <div className={styles.inputRow}>
            <Search size={15} />
            <input
              autoFocus
              className={styles.input}
              placeholder="Jump to a page or project, or deploy…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Search commands"
              aria-controls="command-palette-list"
              aria-activedescendant={results[active] ? `cmd-${results[active].id}` : undefined}
              role="combobox"
              aria-expanded
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <div className={styles.list} id="command-palette-list" role="listbox" ref={listRef}>
            {results.length === 0 && <div className={styles.empty}>No matches.</div>}
            {results.map((command, index) => {
              const heading = command.group !== lastGroup ? command.group : null;
              lastGroup = command.group;
              const Icon = command.icon;
              return (
                <div key={command.id}>
                  {heading && <div className={styles.group}>{heading}</div>}
                  <div
                    id={`cmd-${command.id}`}
                    role="option"
                    aria-selected={index === active}
                    data-index={index}
                    className={index === active ? `${styles.item} ${styles.itemActive}` : styles.item}
                    onMouseMove={() => setActive(index)}
                    onClick={() => runCommand(command)}
                  >
                    <Icon size={14} />
                    <span className={styles.label}>{command.label}</span>
                    {command.hint && <span className={styles.hint}>{command.hint}</span>}
                  </div>
                </div>
              );
            })}
          </div>
          <div className={styles.footer}>
            <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
            <span><kbd>Enter</kbd> open</span>
            <span><kbd>Esc</kbd> close</span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** For the nav: the shortcut label for this platform. */
export const PALETTE_SHORTCUT = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K";
