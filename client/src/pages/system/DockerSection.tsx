import { lazy, Suspense, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Box, ChevronDown, ChevronRight, FileText, Hammer, Layers, Loader, Play, Radio, Square, SquareTerminal } from "lucide-react";
import { api, ApiError } from "../../api/client";
import type { ComposeStack, ContainerInfo, Project } from "../../api/types";
import { ServiceError } from "../../components/ServiceError";
import { StatusChip } from "../../components/StatusChip";
import { SubShellSectionHeader } from "../../components/SubShell";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Stack } from "../../components/ui/stack";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { Hint } from "../../components/ui/text";
import { useSystem } from "../../context/SystemContext";
import { notify } from "../../lib/notify";
import { cn } from "../../lib/utils";
import MaintenanceSection from "../settings/MaintenanceSection";
import StorageSection from "../settings/StorageSection";
import styles from "../System.module.scss";
import { NetworkHeadroomNotice } from "./NetworkHeadroomNotice";
import { OutputBlock } from "./OutputBlock";

// The terminal dialogs pull in xterm (~90 KB gzipped); load it only when one opens.
const ContainerShellDialog = lazy(() => import("../../components/ContainerShellDialog").then((m) => ({ default: m.ContainerShellDialog })));
const ContainerLogDialog = lazy(() => import("../../components/ContainerLogDialog").then((m) => ({ default: m.ContainerLogDialog })));

type ComposeOp = "up" | "down" | "build";
type Result = { ok: boolean; output: string };

const EXPANDED_KEY = "stackport_system_expanded_stacks";

function readExpanded(): Record<string, boolean> {
  try {
    const value = localStorage.getItem(EXPANDED_KEY);
    return value ? JSON.parse(value) as Record<string, boolean> : {};
  } catch {
    return {};
  }
}

/** The project a Compose stack belongs to. Stackport runs a project in a folder named `<id>-<slug>`, and Compose names the stack after it. */
function projectOfStack(stack: ComposeStack, projects: Project[]): Project | null {
  const id = /^(\d+)-/.exec(stack.name)?.[1];
  return id === undefined ? null : projects.find((project) => project.id === Number(id)) ?? null;
}

function StateBadge({ state }: { state: string }) {
  const s = state.toLowerCase();
  const tone = s === "running" ? styles.stateRunning : s === "exited" || s === "dead" ? styles.stateStopped : s === "paused" ? styles.statePaused : styles.stateUnknown;
  return <span className={cn(styles.stateDot, tone)} title={state} />;
}

function ContainerTable({ containers }: { containers: ContainerInfo[] }) {
  const [loadingLogsId, setLoadingLogsId] = useState<string | null>(null);
  const [logsResult, setLogsResult] = useState<{ container: ContainerInfo; lines: number; ok: boolean; output: string } | null>(null);
  const [shellContainer, setShellContainer] = useState<ContainerInfo | null>(null);
  const [logStreamContainer, setLogStreamContainer] = useState<ContainerInfo | null>(null);

  async function viewLogs(container: ContainerInfo) {
    setLoadingLogsId(container.id);
    try {
      const result = await api.getDockerContainerLogs(container.id);
      setLogsResult({ container, lines: result.lines, ok: result.ok, output: result.output });
      if (!result.ok) notify.error(new Error(result.output), `Failed to read ${container.name} logs`);
    } catch (err) {
      notify.error(err, `Failed to read ${container.name} logs`);
    } finally {
      setLoadingLogsId(null);
    }
  }

  if (containers.length === 0) return <div className={styles.compactEmpty}>No containers.</div>;
  return (
    <>
      <Table className={styles.containerTable}>
        <TableHeader>
          <TableRow>
            <TableHead>State</TableHead>
            <TableHead>Service / Name</TableHead>
            <TableHead>Image</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>CPU%</TableHead>
            <TableHead>Mem</TableHead>
            <TableHead>Mem%</TableHead>
            <TableHead>Ports</TableHead>
            <TableHead className={styles.actionsHead}>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {containers.map((c) => (
            <TableRow key={c.id} className={cn(c.state !== "running" && styles.dimmedRow)}>
              <TableCell>
                <StateBadge state={c.state} />
                <span className="mono" style={{ fontSize: "0.9em" }}>{c.state}</span>
              </TableCell>
              <TableCell>
                <span className="mono">{c.service ?? c.name}</span>
                {c.service && <span style={{ color: "var(--dim)", fontSize: "0.8em", marginLeft: 4 }}>({c.name})</span>}
              </TableCell>
              <TableCell className="mono">{c.image}</TableCell>
              <TableCell>{c.status}</TableCell>
              <TableCell className="mono">{c.stats?.cpu ?? "—"}</TableCell>
              <TableCell className="mono">{c.stats?.mem ?? "—"}</TableCell>
              <TableCell className="mono">{c.stats?.memPerc ?? "—"}</TableCell>
              <TableCell className={cn("mono", styles.portsCell)}>{c.ports || "—"}</TableCell>
              <TableCell>
                <Button type="button" variant="ghost" size="icon-xs" onClick={() => void viewLogs(c)} disabled={loadingLogsId !== null} title={`View ${c.name} logs`} aria-label={`View ${c.name} logs`}>
                  {loadingLogsId === c.id ? <Loader size={12} className="spin" /> : <FileText size={12} />}
                </Button>
                <Button type="button" variant="ghost" size="icon-xs" onClick={() => setShellContainer(c)} disabled={c.state !== "running"}
                  title={c.state === "running" ? `Open shell in ${c.name}` : "Container must be running to open a shell"} aria-label={`Open shell in ${c.name}`}>
                  <SquareTerminal size={12} />
                </Button>
                <Button type="button" variant="ghost" size="icon-xs" onClick={() => setLogStreamContainer(c)} title={`Live logs for ${c.name}`} aria-label={`Live logs for ${c.name}`}>
                  <Radio size={12} />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {logsResult && (
        <div className={styles.containerLogs}>
          <div className={styles.resultHeader}>
            <FileText size={12} />
            <span className="mono">{logsResult.container.service ?? logsResult.container.name}</span>
            <span className="muted-text">last {logsResult.lines} lines</span>
          </div>
          <OutputBlock output={logsResult.output} ok={logsResult.ok} onDismiss={() => setLogsResult(null)} />
        </div>
      )}
      {shellContainer && <Suspense fallback={null}><ContainerShellDialog container={shellContainer} onClose={() => setShellContainer(null)} /></Suspense>}
      {logStreamContainer && <Suspense fallback={null}><ContainerLogDialog container={logStreamContainer} onClose={() => setLogStreamContainer(null)} /></Suspense>}
    </>
  );
}

/** One Compose stack: its state on one line, its containers when opened. A Stackport project's stack links to the project (its Compose
 *  up, stop and build live there); a stack that is not a project's keeps those buttons here. */
function StackRow({ stack, project, onAction, activeOp, result, onDismissResult, open, onToggle }: {
  stack: ComposeStack;
  project: Project | null;
  onAction: (stack: string, action: ComposeOp) => Promise<void>;
  activeOp: ComposeOp | null;
  result: Result | null;
  onDismissResult: () => void;
  open: boolean;
  onToggle: () => void;
}) {
  const busy = activeOp !== null;
  const runningCount = stack.containers.filter((c) => c.state === "running").length;
  const totalCount = stack.containers.length;
  const allRunning = totalCount > 0 && runningCount === totalCount;
  const anyRunning = runningCount > 0;

  return (
    <Card className={styles.stackCard}>
      <CardHeader className={styles.stackHeader}>
        <Button type="button" variant="ghost" size="icon-xs" onClick={onToggle} title={open ? "Collapse" : "Expand"} aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${stack.name}`}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </Button>
        <CardTitle className={cn("mono", styles.stackTitle)}>{project ? project.name : stack.name}</CardTitle>
        <StatusChip ok={allRunning} labels={[`${runningCount}/${totalCount} running`, anyRunning ? `${runningCount}/${totalCount} running` : "stopped"]} />
        {!project && stack.configFiles[0] && <span className={cn("mono", styles.stackPath)}>{stack.configFiles[0]}</span>}
        <div className={cn("row-actions", styles.stackActions)}>
          {project ? (
            <Button type="button" variant="outline" size="xs" asChild><Link to={`/projects/${project.id}`}>Open project</Link></Button>
          ) : (
            <>
              <Button type="button" variant="outline" size="xs" className={styles.successButton} onClick={() => void onAction(stack.name, "up")} disabled={busy} title="docker compose up">
                {activeOp === "up" ? <Loader size={12} className="spin" /> : <Play size={12} />}Up
              </Button>
              <Button type="button" variant="outline" size="xs" className={styles.dangerButton} onClick={() => void onAction(stack.name, "down")} disabled={busy} title="docker compose stop">
                {activeOp === "down" ? <Loader size={12} className="spin" /> : <Square size={12} />}Down
              </Button>
              <Button type="button" variant="outline" size="xs" onClick={() => void onAction(stack.name, "build")} disabled={busy} title="docker compose build">
                {activeOp === "build" ? <Loader size={12} className="spin" /> : <Hammer size={12} />}Build
              </Button>
            </>
          )}
        </div>
      </CardHeader>
      {result && <CardContent className={styles.stackResult}><OutputBlock output={result.output} ok={result.ok} onDismiss={onDismissResult} /></CardContent>}
      {open && <CardContent className={styles.stackBody}><ContainerTable containers={stack.containers} /></CardContent>}
    </Card>
  );
}

/** Host > Docker: what runs (Stackport's projects first, then everything else on the machine), and, on its own tab, disk use and cleanup. */
export function DockerSection() {
  const { system: data, projects, refreshSystem: refresh } = useSystem();
  const docker = data?.docker;
  const [tab, setTab] = useState<"containers" | "disk">("containers");
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => readExpanded());
  const [ops, setOps] = useState<Record<string, { op: ComposeOp | null; result: Result | null }>>({});

  useEffect(() => {
    try { localStorage.setItem(EXPANDED_KEY, JSON.stringify(expanded)); } catch { /* a remembered state is a convenience */ }
  }, [expanded]);

  async function composeAction(stackName: string, action: ComposeOp) {
    const toastId = notify.loading(`${stackName}: docker compose ${action}...`);
    setOps((prev) => ({ ...prev, [stackName]: { op: action, result: null } }));
    try {
      const result = await api.composeAction(stackName, action);
      setOps((prev) => ({ ...prev, [stackName]: { op: null, result } }));
      if (result.ok) notify.success(`${stackName}: ${action} completed.`, { id: toastId });
      else notify.error(new Error(result.output || `${action} failed`), `${stackName}: ${action} failed`, { id: toastId });
      if (action !== "build") refresh();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Action failed";
      setOps((prev) => ({ ...prev, [stackName]: { op: null, result: { ok: false, output: message } } }));
      notify.error(err, `${stackName}: ${action} failed`, { id: toastId });
    }
  }

  const stacks = docker?.stacks ?? [];
  const standalone = docker?.standalone ?? [];
  const known = projects ?? [];
  const mine = stacks.filter((stack) => projectOfStack(stack, known));
  const others = stacks.filter((stack) => !projectOfStack(stack, known));
  const allContainers = [...stacks.flatMap((stack) => stack.containers), ...standalone];
  const running = allContainers.filter((c) => c.state === "running").length;

  const row = (stack: ComposeStack) => (
    <StackRow
      key={stack.name}
      stack={stack}
      project={projectOfStack(stack, known)}
      onAction={composeAction}
      activeOp={ops[stack.name]?.op ?? null}
      result={ops[stack.name]?.result ?? null}
      onDismissResult={() => setOps((prev) => ({ ...prev, [stack.name]: { op: null, result: null } }))}
      open={!!expanded[stack.name]}
      onToggle={() => setExpanded((prev) => ({ ...prev, [stack.name]: !prev[stack.name] }))}
    />
  );

  return (
    <>
      <SubShellSectionHeader
        title="Docker"
        icon={Box}
        meta={(
          <>
            {docker?.version && <span className="mono muted-text">v{docker.version}</span>}
            {docker && <StatusChip ok={!!docker.available} labels={["available", "unavailable"]} />}
          </>
        )}
        description="What is running on this machine, Docker's disk use, and the deploy folder."
      />
      {!docker ? (
        <Loader size={14} className="spin" />
      ) : !docker.available ? (
        <ServiceError service="Docker" reason={docker.reason} />
      ) : (
        <Stack gap={4}>
          <Tabs value={tab} onValueChange={(value) => setTab(value as "containers" | "disk")}>
            <TabsList>
              <TabsTrigger value="containers"><Layers size={12} />Containers</TabsTrigger>
              <TabsTrigger value="disk">Disk and cleanup</TabsTrigger>
            </TabsList>
          </Tabs>

          {tab === "containers" ? (
            <>
              <NetworkHeadroomNotice />
              <Hint>{stacks.length} {stacks.length === 1 ? "stack" : "stacks"}, {standalone.length} standalone · {running} of {allContainers.length} containers running</Hint>
              {stacks.length === 0 && standalone.length === 0 && <div className="empty">No containers found.</div>}
              {mine.length > 0 && (
                <Stack gap={2}>
                  <div className={cn(styles.sectionTitle, styles.subsectionTitle)}><Box size={12} />Stackport projects</div>
                  {mine.map(row)}
                </Stack>
              )}
              {others.length > 0 && (
                <Stack gap={2}>
                  <div className={cn(styles.sectionTitle, styles.subsectionTitle)}><Layers size={12} />Other stacks on this host</div>
                  {others.map(row)}
                </Stack>
              )}
              {standalone.length > 0 && (
                <Stack gap={2}>
                  <div className={cn(styles.sectionTitle, styles.subsectionTitle)}><Layers size={12} />Standalone containers</div>
                  <ContainerTable containers={standalone} />
                </Stack>
              )}
            </>
          ) : (
            <Stack gap={4}>
              <StorageSection />
              <MaintenanceSection />
            </Stack>
          )}
        </Stack>
      )}
    </>
  );
}
