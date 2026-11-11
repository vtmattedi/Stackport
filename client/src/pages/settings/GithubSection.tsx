import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AlertCircle, AlertTriangle, ExternalLink, Loader, RefreshCw } from "lucide-react";
import { api, ApiError } from "../../api/client";
import type { GithubDelivery, GithubImportOutcome, GithubManifestStart, GithubScanEntry, GithubSettings } from "../../api/types";
import { Disclosure } from "../../components/Disclosure";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { CheckRow, Field } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { Stack } from "../../components/ui/stack";
import { Textarea } from "../../components/ui/textarea";
import { Hint, Prose } from "../../components/ui/text";
import { notify } from "../../lib/notify";

const MODULE_LABEL: Record<string, string> = {
  deployments: "Report each deploy to GitHub",
  ci: "Deploy only after CI passes",
  releases: "Deploy a release or tag",
};

/** Posts the manifest to GitHub the way its registration flow requires: a form, with the manifest in a field. */
function submitManifest(start: GithubManifestStart): void {
  const form = document.createElement("form");
  form.method = "post";
  form.action = start.registrationUrl;
  const field = document.createElement("input");
  field.type = "hidden";
  field.name = "manifest";
  field.value = JSON.stringify(start.manifest);
  form.appendChild(field);
  document.body.appendChild(form);
  form.submit();
}

export default function GithubSection() {
  const [settings, setSettings] = useState<GithubSettings | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [owner, setOwner] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [modules, setModules] = useState<string[]>([]);
  const [deliveries, setDeliveries] = useState<GithubDelivery[]>([]);
  const [importing, setImporting] = useState<{ installationId: number; entries: GithubScanEntry[]; truncated: boolean; warning: string; chosen: number[] } | null>(null);
  const [importResult, setImportResult] = useState<GithubImportOutcome[] | null>(null);
  const [newKey, setNewKey] = useState("");
  const [newSecret, setNewSecret] = useState("");
  const [params, setParams] = useSearchParams();
  const announced = useRef(false);

  async function load() {
    try {
      const next = await api.getGithubSettings();
      setSettings(next);
      setModules((current) => (current.length ? current : next.modules));
      if (next.app) setDeliveries((await api.getGithubDeliveries()).deliveries);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load the GitHub settings");
    }
  }
  useEffect(() => { void load(); }, []);

  // GitHub sends the browser back here with what happened; say it once and clean the address.
  useEffect(() => {
    if (announced.current || !settings) return;
    const failure = params.get("error");
    if (failure) notify.error(new Error(failure), "GitHub");
    else if (params.get("registered")) notify.success("The App is registered. Install it on your account or organization next.");
    else if (params.get("linked")) notify.success(`Linked ${params.get("linked")} installation(s).`);
    else if (params.get("installed")) notify.success("Installed. Now connect your account so Stackport can confirm it is yours.");
    else return;
    announced.current = true;
    setParams({}, { replace: true });
  }, [params, settings, setParams]);

  async function run(label: string, work: () => Promise<void>) {
    setBusy(label);
    try { await work(); await load(); }
    catch (err) { notify.error(err, "GitHub"); }
    finally { setBusy(""); }
  }

  if (error) return <Alert variant="destructive"><AlertCircle size={14} /><AlertDescription>{error}</AlertDescription></Alert>;
  if (!settings) return <Loader size={14} className="spin" />;
  const { app, preflight } = settings;

  if (!app) {
    return (
      <div className="card">
        <Stack gap={4}>
          <Prose>
            Register a GitHub App for this Stackport. It replaces personal access tokens: it clones with short-lived tokens, lists your
            repositories, and hears about pushes. It is created from a manifest, with this server's own domain in it.
          </Prose>
          {!preflight.ok && (
            <Alert variant="destructive">
              <AlertCircle size={14} />
              <AlertDescription>{preflight.problems.map((problem) => <p key={problem}>{problem}</p>)}</AlertDescription>
            </Alert>
          )}
          <Field label="Organization" optional hint="Leave empty to register it under your own account." htmlFor="github-owner" className="max-w-sm">
            <Input id="github-owner" value={owner} onChange={(event) => setOwner(event.target.value)} placeholder="my-org" disabled={!preflight.ok} />
          </Field>
          <Stack gap={3}>
            <div>
              <div className="text-xs font-medium text-[var(--dim)]">What the App may do</div>
              <Hint className="mt-1">Reading code and hearing about pushes is always included. Each of these adds a permission; adding one later means every installation approves again.</Hint>
            </div>
            {settings.modules.map((name) => (
              <CheckRow
                key={name}
                title={MODULE_LABEL[name] ?? name}
                control={(
                  <Checkbox
                    checked={modules.includes(name)}
                    disabled={!preflight.ok}
                    onCheckedChange={(checked) => setModules(checked === true ? [...modules, name] : modules.filter((m) => m !== name))}
                  />
                )}
              />
            ))}
            <CheckRow
              title="Let other accounts install it"
              hint="Makes it a public App. Installations stay unusable until their owner is proved."
              control={<Checkbox checked={isPublic} disabled={!preflight.ok} onCheckedChange={(checked) => setIsPublic(checked === true)} />}
            />
          </Stack>
          {preflight.origin && preflight.ok && (
            <Hint>GitHub will be given <code className="mono">{preflight.origin}</code> as the App's address and <code className="mono">{preflight.origin}/api/hooks/github/app</code> for webhooks.</Hint>
          )}
          <Alert>
            <AlertTriangle size={14} />
            <AlertDescription>Anyone who can push to a repository you connect controls what runs on this host: the App does not sandbox what a repository deploys.</AlertDescription>
          </Alert>
          <div>
            <Button type="button" disabled={!preflight.ok || busy !== ""}
              onClick={() => void run("register", async () => { submitManifest(await api.startGithubManifest({ modules, owner: owner.trim(), isPublic })); })}>
              {busy === "register" ? <Loader size={14} className="spin" /> : null} Register on GitHub
            </Button>
          </div>
        </Stack>
      </div>
    );
  }

  const noInstallations = settings.installations.length === 0;
  const hasUnlinked = settings.installations.some((installation) => installation.status === "unlinked");

  return (
    <Stack gap={4}>
      <div className="card mb-0!">
        <Stack gap={4}>
          <Stack gap={2}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-base font-semibold">{app.name}</span>
              <Badge variant="outline">{app.isPublic ? "public" : "private"}</Badge>
              <a href={app.htmlUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs">Open on GitHub <ExternalLink size={11} /></a>
            </div>
            <Hint>Owned by <code className="mono">{app.ownerLogin}</code> ({app.ownerType}).</Hint>
            <div className="flex flex-wrap gap-1.5">
              {app.modules.length === 0
                ? <Hint>No modules beyond reading code.</Hint>
                : app.modules.map((module) => <Badge key={module} variant="secondary">{MODULE_LABEL[module] ?? module}</Badge>)}
            </div>
          </Stack>
          {settings.domainDrift && (
            <Alert variant="destructive">
              <AlertCircle size={14} />
              <AlertDescription>
                The App was registered for <code className="mono">{app.registeredOrigin}</code>, but this server is now at <code className="mono">{preflight.origin}</code>.
                GitHub keeps the old addresses until you change them in <a href={`${app.htmlUrl.replace("/apps/", "/settings/apps/")}`} target="_blank" rel="noreferrer">the App's settings</a>:
                the webhook URL, the callback URL and the setup URL.
              </AlertDescription>
            </Alert>
          )}
          <Hint>
            Webhook address: <code className="mono">{preflight.origin ?? "(set the server's domain first)"}{preflight.origin ? "/api/hooks/github/app" : ""}</code>. A push to a project's auto-deploy branch deploys it.
          </Hint>
        </Stack>
      </div>

      <div className="card mb-0!">
        <div className="card-title">Accounts</div>
        <Stack gap={4}>
          {noInstallations ? (
            <Stack gap={2}>
              <Prose>The App is not installed on any account yet.</Prose>
              <Hint>Install it on the account or organization whose repositories you want to deploy, then come back and connect that account so Stackport can confirm it is yours.</Hint>
            </Stack>
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Account</th><th>Status</th><th>Repositories</th><th /></tr></thead>
                <tbody>
                  {settings.installations.map((installation) => (
                    <tr key={installation.installationId}>
                      <td>{installation.accountLogin} <span className="muted-text">({installation.accountType})</span></td>
                      <td>
                        {installation.status === "linked"
                          ? <Badge variant="secondary">linked</Badge>
                          : installation.status === "unlinked"
                            ? <Badge variant="outline">not connected: use Connect an account</Badge>
                            : <Badge variant="outline">{installation.status}</Badge>}
                      </td>
                      <td>{installation.status === "linked" ? installation.repositoryCount : "-"}</td>
                      <td>
                        {installation.status === "linked" && (
                          <div className="flex justify-end gap-2">
                            <Button type="button" size="sm" variant="outline" disabled={busy !== ""}
                              onClick={() => void run(`scan-${installation.installationId}`, async () => {
                                const scan = await api.scanGithubInstallation(installation.installationId);
                                setImportResult(null);
                                setImporting({ installationId: installation.installationId, entries: scan.entries, truncated: scan.truncated, warning: scan.warning, chosen: scan.entries.filter((e) => e.composeFiles.length > 0 && !e.importedAs && !e.archived).map((e) => e.repositoryId) });
                              })}>
                              {busy === `scan-${installation.installationId}` ? <Loader size={14} className="spin" /> : null} Import repositories
                            </Button>
                            <Button type="button" size="sm" variant="outline" disabled={busy !== ""}
                              onClick={() => void run(`refresh-${installation.installationId}`, async () => { const result = await api.refreshGithubInstallation(installation.installationId); notify.success(`${result.repositories} repositories.`); })}>
                              {busy === `refresh-${installation.installationId}` ? <Loader size={14} className="spin" /> : <RefreshCw size={14} />} Refresh
                            </Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant={noInstallations ? "default" : "outline"} asChild>
              <a href={`${app.htmlUrl}/installations/new`} target="_blank" rel="noreferrer">Install on an account <ExternalLink size={13} /></a>
            </Button>
            <Button type="button" variant={hasUnlinked ? "default" : "outline"} disabled={busy !== "" || noInstallations} onClick={() => void run("link", async () => { window.location.href = (await api.startGithubLink()).authorizeUrl; })}>
              {busy === "link" ? <Loader size={14} className="spin" /> : null} Connect an account
            </Button>
            <Button type="button" variant="outline" disabled={busy !== ""} onClick={() => void run("sync", async () => { await api.syncGithubInstallations(); })}>
              {busy === "sync" ? <Loader size={14} className="spin" /> : <RefreshCw size={14} />} Check GitHub for installations
            </Button>
          </div>
        </Stack>
      </div>

      {importing && (
        <div className="card mb-0!">
          <div className="card-title">Import repositories</div>
          <Stack gap={4}>
            <Hint>Each ticked repository becomes a project on its default branch. Nothing is cloned or deployed: you decide when. {importing.warning}</Hint>
            {importing.truncated && <Hint>Only the first 100 repositories were looked at.</Hint>}
            <div className="table-wrap">
              <table>
                <thead><tr><th /><th>Repository</th><th>Compose file</th></tr></thead>
                <tbody>
                  {importing.entries.map((entry) => {
                    const importable = entry.composeFiles.length > 0 && !entry.importedAs;
                    return (
                      <tr key={entry.repositoryId}>
                        <td>
                          <Checkbox disabled={!importable} aria-label={`Import ${entry.fullName}`}
                            checked={importing.chosen.includes(entry.repositoryId)}
                            onCheckedChange={(checked) => setImporting({ ...importing, chosen: checked === true ? [...importing.chosen, entry.repositoryId] : importing.chosen.filter((id) => id !== entry.repositoryId) })} />
                        </td>
                        <td className="mono">{entry.fullName}{entry.isPrivate ? " (private)" : ""}{entry.archived ? " (archived)" : ""}</td>
                        <td>{entry.importedAs ? `already the project "${entry.importedAs.name}"` : entry.composeFiles.length > 0 ? entry.composeFiles.join(", ") : <span className="muted-text">{entry.note}</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex gap-2">
              <Button type="button" disabled={busy !== "" || importing.chosen.length === 0}
                onClick={() => void run("import", async () => { const result = await api.importGithubRepositories(importing.installationId, importing.chosen); setImportResult(result.outcomes); setImporting(null); })}>
                {busy === "import" ? <Loader size={14} className="spin" /> : null} Import {importing.chosen.length}
              </Button>
              <Button type="button" variant="outline" onClick={() => setImporting(null)}>Cancel</Button>
            </div>
          </Stack>
        </div>
      )}
      {importResult && (
        <div className="card mb-0!" role="status">
          <div className="card-title">Imported</div>
          <ul className="grid gap-1.5 text-[13px]">
            {importResult.map((outcome) => (
              <li key={outcome.repositoryId}>
                <span className="mono">{outcome.fullName ?? outcome.repositoryId}</span>: {outcome.status === "created" && outcome.project
                  ? <>created as <Link to={`/projects/${outcome.project.id}`}>{outcome.project.name}</Link></>
                  : `skipped. ${outcome.reason ?? ""}`}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card mb-0!">
        <div className="card-title">Recent deliveries</div>
        {deliveries.length === 0 ? (
          <Hint>Nothing received yet. GitHub sends a delivery when someone pushes, or when an installation changes.</Hint>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Received</th><th>Event</th><th>Result</th><th /></tr></thead>
              <tbody>
                {deliveries.slice(0, 20).map((delivery) => (
                  <tr key={delivery.deliveryId}>
                    <td className="mono">{delivery.receivedAt}</td>
                    <td>{delivery.event}{delivery.action ? ` / ${delivery.action}` : ""}</td>
                    <td><strong>{delivery.status}</strong>{delivery.detail ? `: ${delivery.detail}` : ""}{delivery.attempts > 1 ? ` (${delivery.attempts} attempts)` : ""}</td>
                    <td className="text-right">
                      <Button type="button" size="sm" variant="outline" disabled={busy !== ""}
                        onClick={() => void run(`replay-${delivery.deliveryId}`, async () => { const result = await api.replayGithubDelivery(delivery.deliveryId); setDeliveries(result.deliveries); notify.success(`Replayed: ${result.status}.`); })}>
                        Replay
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Disclosure title="Rotate credentials">
        <Stack gap={4}>
          <Hint>
            Generate a new private key in <a href={`${app.htmlUrl.replace("/apps/", "/settings/apps/")}`} target="_blank" rel="noreferrer">the App's settings</a> and paste it here. Stackport
            checks with GitHub that the key works for this App before it replaces the old one, so a wrong paste changes nothing. A new webhook secret has to be set
            on GitHub as well; Stackport cannot check it.
          </Hint>
          <Field label="New private key (PEM)" htmlFor="github-new-key">
            <Textarea id="github-new-key" rows={4} className="font-mono text-xs" value={newKey} onChange={(event) => setNewKey(event.target.value)} spellCheck={false} autoComplete="off" />
          </Field>
          <Field label="New webhook secret" htmlFor="github-new-secret" className="max-w-sm">
            <Input id="github-new-secret" type="password" value={newSecret} onChange={(event) => setNewSecret(event.target.value)} autoComplete="off" />
          </Field>
          <div>
            <Button type="button" size="sm" disabled={busy !== "" || (!newKey.trim() && !newSecret)}
              onClick={() => void run("rotate", async () => {
                const result = await api.rotateGithubCredentials({ ...(newKey.trim() ? { privateKey: newKey.trim() } : {}), ...(newSecret ? { webhookSecret: newSecret } : {}) });
                setNewKey(""); setNewSecret("");
                notify.success(result.privateKey && result.webhookSecret ? "Key and webhook secret replaced." : result.privateKey ? "Private key replaced." : "Webhook secret replaced.");
              })}>
              Replace
            </Button>
          </div>
        </Stack>
      </Disclosure>
      <Disclosure title="Forget this App">
        <Stack gap={4}>
          <Hint>Removes the App from this Stackport. It does not delete it on GitHub (do that in the App's settings), and it is refused while a project still deploys through it.</Hint>
          <div>
            <Button type="button" variant="destructive" size="sm" disabled={busy !== ""}
              onClick={() => void run("forget", async () => { await api.forgetGithubApp(); notify.success("The App was forgotten."); })}>
              Forget the App
            </Button>
          </div>
        </Stack>
      </Disclosure>
    </Stack>
  );
}
