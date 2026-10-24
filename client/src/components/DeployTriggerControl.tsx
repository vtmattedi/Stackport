import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Copy, Eye, EyeOff, Loader, RefreshCw, Send } from "lucide-react";
import { AppSelect } from "./AppSelect";
import { Button } from "./ui/button";
import { api } from "../api/client";
import type { DeployTrigger, Project, ProjectWebhookInfo } from "../api/types";
import { formatTimeAgo } from "../lib/format";
import { notify } from "../lib/notify";
import { cn } from "../lib/utils";
import styles from "./DeployTriggerControl.module.scss";

const HOOK_STATUS_LABEL = {
  waiting: "Waiting for first delivery",
  verified: "Receiving deliveries",
  failing: "Missed a push",
} as const;

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    notify.success(`${what} copied.`);
  } catch (err) {
    notify.error(err, `Couldn't copy ${what.toLowerCase()}`);
  }
}

/** Webhook status, setup details and recent deliveries for a project using the webhook trigger. */
function WebhookPanel({ project, info, onChange, reload }: {
  project: Project;
  info: ProjectWebhookInfo | null;
  onChange: (updated: Project) => void;
  reload: () => void;
}) {
  const [showSecret, setShowSecret] = useState(false);
  const [busy, setBusy] = useState<"ping" | "reinstall" | null>(null);
  const state = project.webhook;
  const details = info?.details ?? null;

  async function ping() {
    setBusy("ping");
    try {
      await api.pingProjectWebhook(project.id);
      notify.success("GitHub is sending a ping.");
      setTimeout(reload, 3000);
    } catch (err) {
      notify.error(err, "Ping failed");
    } finally {
      setBusy(null);
    }
  }

  async function reinstall() {
    setBusy("reinstall");
    try {
      const result = await api.reinstallProjectWebhook(project.id);
      onChange(result.project);
      if (result.installError) notify.error(new Error(result.installError), "Couldn't install the hook on GitHub");
      else notify.success("Hook installed on GitHub.");
      reload();
    } catch (err) {
      notify.error(err, "Reinstall failed");
    } finally {
      setBusy(null);
    }
  }

  if (!state) return null;
  return (
    <div className={styles.panel}>
      <div className={styles.statusLine}>
        <span className={cn(styles.dot, styles[state.status])} />
        <span>{HOOK_STATUS_LABEL[state.status]}</span>
        {state.lastDeliveryAt && <span className="muted-text">· last {formatTimeAgo(state.lastDeliveryAt)}</span>}
        <span className="muted-text">· {state.installedOnGithub ? "installed by Stackport" : "manual install"}</span>
      </div>
      {state.status === "failing" && (
        <span className={styles.warn}>The safety check found a commit the hook didn't deliver. Check the hook's recent deliveries on GitHub, or reinstall it.</span>
      )}

      {details?.url && !state.installedOnGithub && (
        <div className={styles.manual}>
          <span>Add this hook in the repo's <strong>Settings &gt; Webhooks</strong>: content type <span className="mono">application/json</span>, event <span className="mono">push</span>.</span>
          <div className={styles.copyRow}>
            <span className="mono">{details.url}</span>
            <Button type="button" variant="ghost" size="icon-xs" onClick={() => void copy(details.url ?? "", "Payload URL")} title="Copy payload URL" aria-label="Copy payload URL"><Copy size={12} /></Button>
          </div>
          {details.secret && (
            <div className={styles.copyRow}>
              <span className="mono">{showSecret ? details.secret : "•".repeat(24)}</span>
              <Button type="button" variant="ghost" size="icon-xs" onClick={() => setShowSecret((v) => !v)} title={showSecret ? "Hide secret" : "Show secret"} aria-label={showSecret ? "Hide secret" : "Show secret"}>
                {showSecret ? <EyeOff size={12} /> : <Eye size={12} />}
              </Button>
              <Button type="button" variant="ghost" size="icon-xs" onClick={() => void copy(details.secret ?? "", "Secret")} title="Copy secret" aria-label="Copy secret"><Copy size={12} /></Button>
            </div>
          )}
        </div>
      )}

      <div className="row-actions">
        <Button type="button" variant="outline" size="xs" onClick={() => void ping()} disabled={busy !== null || !state.installedOnGithub}
          title={state.installedOnGithub ? "Ask GitHub to send a ping" : "Only available when Stackport installed the hook"}>
          {busy === "ping" ? <Loader size={12} className="spin" /> : <Send size={12} />}
          Send test ping
        </Button>
        <Button type="button" variant="outline" size="xs" onClick={() => void reinstall()} disabled={busy !== null}>
          {busy === "reinstall" ? <Loader size={12} className="spin" /> : <RefreshCw size={12} />}
          {state.installedOnGithub ? "Reinstall on GitHub" : "Install on GitHub"}
        </Button>
      </div>

      {details && details.deliveries.length > 0 && (
        <ul className={styles.deliveries}>
          {details.deliveries.map((d) => (
            <li key={d.id}>
              <span className={cn(styles.outcome, d.outcome === "deploying" || d.outcome === "queued" || d.outcome === "ping" ? styles.good : d.outcome === "rejected" ? styles.bad : null)}>{d.outcome}</span>
              <span className="mono">{d.event}{d.sha ? ` ${d.sha.slice(0, 7)}` : ""}</span>
              <span className="muted-text">{d.detail}</span>
              <span className="muted-text" title={d.receivedAt}>{formatTimeAgo(d.receivedAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Deploy trigger picker (applies immediately) plus what the poller or webhook last saw for this project. */
export function DeployTriggerControl({ project, onChange }: { project: Project; onChange: (updated: Project) => void }) {
  const [saving, setSaving] = useState(false);
  const [info, setInfo] = useState<ProjectWebhookInfo | null>(null);

  const reload = useCallback(() => {
    api.getProjectWebhook(project.id).then(setInfo).catch(() => {});
  }, [project.id]);

  // Refetch when the hook state changes (a delivery arrives over the live project update).
  useEffect(reload, [reload, project.webhook?.lastDeliveryAt, project.webhook?.installedOnGithub]);

  async function change(value: string) {
    setSaving(true);
    try {
      const result = await api.setDeployTrigger(project.id, value as DeployTrigger);
      onChange(result.project);
      if (result.installError) notify.error(new Error(result.installError), "Webhook is on, but the hook isn't installed on GitHub yet");
      else if (value === "webhook") notify.success("Webhook installed on GitHub.");
      if (result.warning) notify.error(new Error(result.warning), "Webhook removed from Stackport");
      reload();
    } catch (err) {
      notify.error(err, "Failed to change deploy trigger");
    } finally {
      setSaving(false);
    }
  }

  const webhookBlocked = info !== null && !info.available && project.deployTrigger !== "webhook";
  const options = [
    { value: "poller", label: "Poller" },
    { value: "webhook", label: webhookBlocked ? "Webhook (needs HTTPS)" : "Webhook", disabled: webhookBlocked || !project.githubRepo },
    { value: "manual", label: "Manual only" },
  ];

  const pollerStatus = project.deployTrigger !== "poller" ? null
    : project.githubCheckError ? <span className={styles.warn}>Last check failed {formatTimeAgo(project.githubCheckedAt)}: {project.githubCheckError}</span>
    : project.githubCheckedAt ? <span className="muted-text">Last checked {formatTimeAgo(project.githubCheckedAt)}</span>
    : <span className="muted-text">Not checked yet. Is the poller enabled in <Link className="ext-link" to="/settings/deploy-triggers">Settings</Link>?</span>;

  return (
    <div className={styles.control}>
      <AppSelect value={project.deployTrigger} onValueChange={(value) => void change(value)} options={options} disabled={saving} />
      {webhookBlocked && info?.unavailableReason && <span className="muted-text">{info.unavailableReason}</span>}
      {!project.autoDeployBranch && project.deployTrigger !== "manual" && (
        <span className="muted-text">No auto-deploy branch set, so nothing deploys automatically.</span>
      )}
      {pollerStatus}
      {project.deployTrigger === "webhook" && <WebhookPanel project={project} info={info} onChange={onChange} reload={reload} />}
      {project.pendingDeploySha && (
        <span>Deploy of <span className="mono">{project.pendingDeploySha.slice(0, 7)}</span> queued until the current action ends.</span>
      )}
    </div>
  );
}
