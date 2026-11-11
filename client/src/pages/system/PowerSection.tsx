import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, AlertTriangle, Loader, Power, RefreshCw } from "lucide-react";
import { api, ApiError } from "../../api/client";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { AppSelect } from "../../components/AppSelect";
import { SubShellSectionHeader } from "../../components/SubShell";
import { notify } from "../../lib/notify";

const DELAYS = [
  { value: "0", label: "Now" },
  { value: "1", label: "In 1 minute" },
  { value: "5", label: "In 5 minutes" },
  { value: "15", label: "In 15 minutes" },
];

function untilText(seconds: number): string {
  if (seconds <= 0) return "now";
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes} min ${seconds % 60} s` : `${seconds} s`;
}

/** Reboot the machine. The app only asks: a signed request file and a systemd unit on the host do it (see the Power notes in the docs). */
export function PowerSection() {
  const queryClient = useQueryClient();
  const { data, error, isFetching, refetch } = useQuery({
    queryKey: ["system", "power"],
    queryFn: () => api.getPower(),
    // Quick while something is happening, slow otherwise.
    refetchInterval: (query) => (query.state.data?.state.requestPending || query.state.data?.state.rebootScheduled ? 3_000 : 30_000),
    retry: false,
  });
  const [delay, setDelay] = useState("1");
  const [typed, setTyped] = useState("");
  const [interrupt, setInterrupt] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const scheduled = data?.state.rebootScheduled === true;
  useEffect(() => {
    if (!scheduled) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [scheduled]);

  const header = (
    <SubShellSectionHeader
      title="Power"
      icon={Power}
      description="Reboot this machine. Stackport asks; a unit on the host does it, after checking a signature."
      actions={(
        <Button type="button" variant="outline" size="xs" onClick={() => void refetch()} disabled={isFetching}>
          <RefreshCw size={13} className={isFetching ? "spin" : undefined} />
          Refresh
        </Button>
      )}
    />
  );

  if (error) return <>{header}<Alert variant="destructive"><AlertCircle size={14} /><AlertDescription>{error instanceof Error ? error.message : "Could not read the power state."}</AlertDescription></Alert></>;
  if (!data) return <>{header}<Loader size={14} className="spin" /></>;

  const { state, preflight } = data;
  const status = state.status;
  const actionsRunning = preflight.runningActions.length;
  const canSubmit = state.available && !state.requestPending && !scheduled && typed.trim() === "reboot" && (actionsRunning === 0 || interrupt) && !busy;

  async function reboot() {
    setBusy(true);
    try {
      await api.rebootHost({ delayMinutes: Number(delay), confirm: typed.trim(), interruptActions: interrupt });
      notify.success("The host has been asked to reboot.");
      setTyped("");
      setInterrupt(false);
      await queryClient.invalidateQueries({ queryKey: ["system", "power"] });
    } catch (err) {
      notify.error(err instanceof ApiError ? new Error(err.message) : err, "Could not request the reboot");
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    try {
      await api.cancelHostReboot();
      notify.success("Asked the host to cancel the reboot.");
      await queryClient.invalidateQueries({ queryKey: ["system", "power"] });
    } catch (err) {
      notify.error(err instanceof ApiError ? new Error(err.message) : err, "Could not cancel");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {header}
      <div style={{ display: "grid", gap: 16 }}>
        {scheduled && status?.rebootAt && (
          <Alert role="status">
            <AlertTriangle size={14} />
            <AlertTitle>A reboot is scheduled</AlertTitle>
            <AlertDescription>
              <p>The machine reboots {untilText(Math.round((status.rebootAt * 1000 - now) / 1000))}{status.by ? `, as asked by ${status.by}` : ""}. Stackport and every project go down while it restarts.</p>
              <Button type="button" variant="outline" size="sm" onClick={() => void cancel()} disabled={busy}>Cancel the reboot</Button>
            </AlertDescription>
          </Alert>
        )}
        {state.requestPending && (
          <Alert role="status"><Loader size={14} className="spin" /><AlertDescription>Waiting for the host to pick up the request…</AlertDescription></Alert>
        )}
        {!scheduled && !state.requestPending && status && (status.state === "rejected" || status.state === "failed") && (
          <Alert variant="destructive">
            <AlertCircle size={14} />
            <AlertTitle>The host did not act on the last request</AlertTitle>
            <AlertDescription>{status.detail ?? "No reason was recorded."}</AlertDescription>
          </Alert>
        )}

        <div className="card">
          <div className="card-title"><Power size={13} />Reboot this machine</div>
          {!state.available ? (
            <Alert>
              <AlertCircle size={14} />
              <AlertDescription>{state.unavailableReason}</AlertDescription>
            </Alert>
          ) : (
            <>
              <p className="hint" style={{ maxWidth: "80ch" }}>
                A reboot stops Stackport and every project, then brings back what Docker restarts by itself. Containers whose Compose file sets no <span className="mono">restart:</span> policy stay stopped until someone starts them.
                {" "}{preflight.dockerRead ? `${preflight.runningContainers} containers are running now.` : "Docker could not be read, so the lists below are incomplete."}
              </p>

              {preflight.containersWithoutRestart.length > 0 && (
                <Alert style={{ marginBottom: 12 }}>
                  <AlertTriangle size={14} />
                  <AlertTitle>{preflight.containersWithoutRestart.length} running {preflight.containersWithoutRestart.length === 1 ? "container has" : "containers have"} no restart policy</AlertTitle>
                  <AlertDescription><span className="mono">{preflight.containersWithoutRestart.join(", ")}</span> will stay stopped after the reboot.</AlertDescription>
                </Alert>
              )}
              {actionsRunning > 0 && (
                <Alert variant="destructive" style={{ marginBottom: 12 }}>
                  <AlertTriangle size={14} />
                  <AlertTitle>{actionsRunning} {actionsRunning === 1 ? "action is" : "actions are"} running</AlertTitle>
                  <AlertDescription>
                    <p>{preflight.runningActions.map((action) => `${action.kind} (${action.key})`).join(", ")}. A reboot cuts them off, which can leave a deploy half done.</p>
                    <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <input type="checkbox" checked={interrupt} onChange={(e) => setInterrupt(e.target.checked)} /> They may be interrupted
                    </label>
                  </AlertDescription>
                </Alert>
              )}

              <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
                <div className="field" style={{ minWidth: 170, flex: "none" }}>
                  <label>When</label>
                  <AppSelect value={delay} onValueChange={setDelay} options={DELAYS} />
                </div>
                <div className="field" style={{ flex: "1 1 220px", minWidth: 0 }}>
                  <label htmlFor="power-confirm">Type <span className="mono">reboot</span> to confirm</label>
                  <input id="power-confirm" type="text" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
                </div>
                <Button type="button" variant="destructive" onClick={() => void reboot()} disabled={!canSubmit}>
                  {busy ? <Loader size={14} className="spin" /> : <Power size={14} />} Reboot
                </Button>
              </div>
            </>
          )}
        </div>

        <div className="card">
          <div className="card-title">From the server</div>
          <p className="hint" style={{ maxWidth: "80ch" }}>
            The same thing over SSH, which also works when Stackport is down: <span className="mono">sudo stackport reboot --in 5</span>. It lists the containers that will not come back,
            then asks you to type REBOOT.
          </p>
        </div>
      </div>
    </>
  );
}
