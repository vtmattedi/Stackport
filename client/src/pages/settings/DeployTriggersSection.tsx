import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronRight, GitBranch, KeyRound, Loader, RefreshCw, Save, X } from "lucide-react";
import { AppSelect } from "../../components/AppSelect";
import { GitHubTokenSelect } from "../../components/GitHubTokenSelect";
import { Button } from "../../components/ui/button";
import { Switch } from "../../components/ui/switch";
import { api } from "../../api/client";
import type { Credential, GitHubPollerConfig } from "../../api/types";
import { formatShortDateTime } from "../../lib/format";
import { notify } from "../../lib/notify";
import { cn } from "../../lib/utils";
import styles from "../System.module.scss";

/** Global GitHub poller config: on/off, interval and the fallback credential. */
export default function DeployTriggersSection() {
  const [ghConfig, setGhConfig] = useState<GitHubPollerConfig | null>(null);
  const [ghCredentialIdDraft, setGhCredentialIdDraft] = useState<number | null>(null);
  const [ghIntervalDraft, setGhIntervalDraft] = useState("300");
  const [ghEnabledDraft, setGhEnabledDraft] = useState(false);
  const [safetyDraft, setSafetyDraft] = useState(true);
  const [savingGh, setSavingGh] = useState(false);
  const [pollingGh, setPollingGh] = useState(false);
  const [loadingGhConfig, setLoadingGhConfig] = useState(false);
  const [ghCredentials, setGhCredentials] = useState<Credential[]>([]);
  const [ghPollOutputOpen, setGhPollOutputOpen] = useState(false);

  useEffect(() => {
    if (ghConfig) return;
    setLoadingGhConfig(true);
    Promise.all([api.getGithubPollerConfig(), api.listCredentials()])
      .then(([cfg, creds]) => {
        setGhConfig(cfg);
        setGhEnabledDraft(cfg.enabled);
    setSafetyDraft(cfg.webhookSafetyCheck);
        setSafetyDraft(cfg.webhookSafetyCheck);
        setGhIntervalDraft(String(cfg.pollIntervalS));
        setGhCredentialIdDraft(cfg.credentialId);
        setGhCredentials(creds.filter((c) => c.type === "github"));
      })
      .catch(() => {})
      .finally(() => setLoadingGhConfig(false));
  }, [ghConfig]);

  function syncGhConfig(cfg: GitHubPollerConfig) {
    setGhConfig(cfg);
    setGhEnabledDraft(cfg.enabled);
    setGhIntervalDraft(String(cfg.pollIntervalS));
    setGhCredentialIdDraft(cfg.credentialId);
  }

  async function handleGhSave() {
    const toastId = notify.loading("Saving GitHub poller config...");
    setSavingGh(true);
    try {
      const cfg = await api.updateGithubPollerConfig({
        enabled: ghEnabledDraft,
        credentialId: ghCredentialIdDraft,
        pollIntervalS: Number(ghIntervalDraft) || 300,
        webhookSafetyCheck: safetyDraft,
      });
      syncGhConfig(cfg);
      notify.success("GitHub poller config saved.", { id: toastId });
    } catch (err) {
      notify.error(err, "Failed to save GitHub poller config", { id: toastId });
    } finally {
      setSavingGh(false);
    }
  }

  async function handleGhPollNow() {
    const toastId = notify.loading("Triggering GitHub poll...");
    setPollingGh(true);
    setGhPollOutputOpen(false);
    try {
      await api.triggerGithubPoll();
      notify.success("GitHub poll triggered.", { id: toastId });
      setTimeout(() => {
        api.getGithubPollerConfig().then(syncGhConfig).catch(() => {});
      }, 3000);
    } catch (err) {
      notify.error(err, "Failed to trigger GitHub poll", { id: toastId });
    } finally {
      setPollingGh(false);
    }
  }

  const POLL_INTERVALS = [
    { label: "1 min", value: "60" },
    { label: "5 min", value: "300" },
    { label: "15 min", value: "900" },
    { label: "30 min", value: "1800" },
    { label: "1 hour", value: "3600" },
  ];

  const ghChanged = ghConfig ? (
    ghEnabledDraft !== ghConfig.enabled ||
    safetyDraft !== ghConfig.webhookSafetyCheck ||
    ghCredentialIdDraft !== ghConfig.credentialId ||
    ghIntervalDraft !== String(ghConfig.pollIntervalS)
  ) : true;

  return (
    <section className={styles.systemPanel}>
      <div className={styles.sectionTitle}>
        <GitBranch size={14} />
        GitHub Poller
        {ghConfig && (
          <span className={cn(styles.titleMeta, "mono")} style={{ fontSize: "0.78rem" }}>
            {ghConfig.enabled ? "enabled" : "disabled"}
          </span>
        )}
        <div className={cn("row-actions", styles.titleActions)}>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => void handleGhPollNow()}
            disabled={pollingGh || loadingGhConfig || !ghConfig?.enabled}
            title={ghConfig?.enabled ? "Trigger a poll now" : "Enable poller first"}
          >
            {pollingGh ? <Loader size={12} className="spin" /> : <RefreshCw size={12} />}
            Poll now
          </Button>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => void handleGhSave()}
            disabled={savingGh || loadingGhConfig || !ghChanged}
          >
            {savingGh ? <Loader size={12} className="spin" /> : <Save size={12} />}
            Save
          </Button>
        </div>
      </div>

      {loadingGhConfig ? (
        <div className={styles.loadingState} style={{ padding: 32 }}>
          <Loader size={18} className="spin" />
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", gap: 20, alignItems: "flex-end", flexWrap: "wrap" }}>
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 500, fontSize: "0.85rem", cursor: "pointer" }}>
              <Switch
                checked={ghEnabledDraft}
                onCheckedChange={(v) => setGhEnabledDraft(v)}
              />
              {ghEnabledDraft ? "Enabled" : "Disabled"}
            </label>

            <div className="field" style={{ margin: 0 }}>
              <label>Poll interval</label>
              <AppSelect
                value={ghIntervalDraft}
                onValueChange={setGhIntervalDraft}
                options={POLL_INTERVALS.map((opt) => ({ value: opt.value, label: opt.label }))}
              />
            </div>

            <div className="field" style={{ margin: 0, minWidth: 200 }}>
              <label>
                <KeyRound size={12} />
                GitHub credential
              </label>
              <GitHubTokenSelect
                credentials={ghCredentials}
                value={ghCredentialIdDraft}
                onValueChange={setGhCredentialIdDraft}
                placeholder="None (public repos only)"
                noneLabel="None (public repos only)"
              />
              {ghCredentials.length === 0 && (
                <div style={{ fontSize: "0.75rem", color: "var(--dim)", marginTop: 3 }}>
                  Add a GitHub credential on the <Link className="ext-link" to="/credentials">Credentials page</Link> first.
                </div>
              )}
            </div>
          </div>

          <p className="muted-text" style={{ margin: 0, fontSize: "0.82rem" }}>
            Each project picks its trigger on its own page: Poller, Webhook or Manual. The poller checks projects set to Poller on this interval.
          </p>

          <div className={styles.webhookSettings}>
            <strong>Webhooks</strong>
            {ghConfig?.webhookBaseUrl ? (
              <span className="muted-text">GitHub will call <span className="mono">{ghConfig.webhookBaseUrl}/api/hooks/github/…</span></span>
            ) : (
              <span className={styles.webhookUnavailable}>{ghConfig?.webhookUnavailableReason ?? "Webhooks are unavailable."}</span>
            )}
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: "0.85rem", cursor: "pointer" }}>
              <Switch checked={safetyDraft} onCheckedChange={setSafetyDraft} />
              Safety check webhook projects every 30 minutes
            </label>
            <span className="muted-text" style={{ fontSize: "0.78rem" }}>
              Catches pushes whose delivery was lost while Stackport was down. Runs with the poller, so the poller must be enabled.
            </span>
          </div>

          {ghConfig && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: "0.82rem" }}>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", color: "var(--dim)" }}>
                <span>Last poll: <span className="mono">{formatShortDateTime(ghConfig.lastPolledAt, "never")}</span></span>
                {ghConfig.lastError && (
                  <span style={{ color: "var(--danger)" }}>Error: {ghConfig.lastError}</span>
                )}
              </div>

              {ghConfig.lastPollOutput && (
                <div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ fontSize: "0.78rem", padding: "2px 6px" }}
                    onClick={() => setGhPollOutputOpen((v) => !v)}
                  >
                    {ghPollOutputOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                    Last poll output
                  </button>
                  {ghPollOutputOpen && (
                    <div className={styles.outputShell} style={{ marginTop: 6 }}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className={styles.outputDismiss}
                        onClick={() => setGhPollOutputOpen(false)}
                        title="Collapse"
                      >
                        <X size={12} />
                      </Button>
                      <pre className={cn("output-block", styles.outputBlock, !!ghConfig.lastError && "output-stderr")}>
                        {ghConfig.lastPollOutput}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );

}
