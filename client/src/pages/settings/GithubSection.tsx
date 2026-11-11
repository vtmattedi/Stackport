import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AlertCircle, Loader, RefreshCw } from "lucide-react";
import { api, ApiError } from "../../api/client";
import type { GithubManifestStart, GithubSettings } from "../../api/types";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
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
  const [params, setParams] = useSearchParams();
  const announced = useRef(false);

  async function load() {
    try {
      const next = await api.getGithubSettings();
      setSettings(next);
      setModules((current) => (current.length ? current : next.modules));
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
        <p className="hint">
          Register a GitHub App for this Stackport. It replaces personal access tokens: it clones with short-lived tokens, lists your
          repositories, and (in the next steps) hears about pushes. It is created from a manifest, with this server's own domain in it.
        </p>
        {!preflight.ok && (
          <Alert variant="destructive">
            <AlertCircle size={14} />
            <AlertDescription>{preflight.problems.map((problem) => <p key={problem}>{problem}</p>)}</AlertDescription>
          </Alert>
        )}
        <div className="field">
          <label>Organization (leave empty for your own account)</label>
          <Input value={owner} onChange={(event) => setOwner(event.target.value)} placeholder="my-org" disabled={!preflight.ok} />
        </div>
        <div className="field">
          <label>What the App may do</label>
          <p className="hint">Reading code and hearing about pushes is always included. Each of these adds a permission; adding one later means every installation approves again.</p>
          {settings.modules.map((name) => (
            <label key={name} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked={modules.includes(name)} disabled={!preflight.ok}
                onChange={(event) => setModules(event.target.checked ? [...modules, name] : modules.filter((m) => m !== name))} />
              {MODULE_LABEL[name] ?? name}
            </label>
          ))}
        </div>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={isPublic} disabled={!preflight.ok} onChange={(event) => setIsPublic(event.target.checked)} />
          Let other accounts install it (a public App). Installations stay unusable until their owner is proved.
        </label>
        {preflight.origin && preflight.ok && (
          <p className="hint">GitHub will be given <code className="mono">{preflight.origin}</code> as the App's address and <code className="mono">{preflight.origin}/api/hooks/github/app</code> for webhooks.</p>
        )}
        <Button type="button" disabled={!preflight.ok || busy !== ""}
          onClick={() => void run("register", async () => { submitManifest(await api.startGithubManifest({ modules, owner: owner.trim(), isPublic })); })}>
          {busy === "register" ? <Loader size={14} className="spin" /> : null} Register on GitHub
        </Button>
        <p className="hint">Anyone who can push to a repository you connect controls what runs on this host: the App does not sandbox what a repository deploys.</p>
      </div>
    );
  }

  return (
    <div className="card">
      <p>
        <strong>{app.name}</strong> owned by <code className="mono">{app.ownerLogin}</code> ({app.ownerType}).{" "}
        <a href={app.htmlUrl} target="_blank" rel="noreferrer">Open on GitHub</a>
      </p>
      <p className="hint">Modules: {app.modules.length ? app.modules.map((m) => MODULE_LABEL[m] ?? m).join(", ") : "none beyond reading code"}.</p>
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
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button type="button" variant="outline" asChild><a href={`${app.htmlUrl}/installations/new`} target="_blank" rel="noreferrer">Install on an account</a></Button>
        <Button type="button" disabled={busy !== ""} onClick={() => void run("link", async () => { window.location.href = (await api.startGithubLink()).authorizeUrl; })}>
          {busy === "link" ? <Loader size={14} className="spin" /> : null} Connect an account
        </Button>
        <Button type="button" variant="outline" disabled={busy !== ""} onClick={() => void run("sync", async () => { await api.syncGithubInstallations(); })}>
          {busy === "sync" ? <Loader size={14} className="spin" /> : <RefreshCw size={14} />} Check GitHub for installations
        </Button>
      </div>
      {settings.installations.length === 0 ? (
        <p className="hint">No installations yet. Install the App on an account, then connect that account here.</p>
      ) : (
        <table>
          <thead><tr><th>Account</th><th>Status</th><th>Repositories</th><th /></tr></thead>
          <tbody>
            {settings.installations.map((installation) => (
              <tr key={installation.installationId}>
                <td>{installation.accountLogin} <span className="muted-text">({installation.accountType})</span></td>
                <td>{installation.status === "unlinked" ? "not connected: use Connect an account" : installation.status}</td>
                <td>{installation.status === "linked" ? installation.repositoryCount : "-"}</td>
                <td>
                  {installation.status === "linked" && (
                    <Button type="button" size="sm" variant="outline" disabled={busy !== ""}
                      onClick={() => void run(`refresh-${installation.installationId}`, async () => { const result = await api.refreshGithubInstallation(installation.installationId); notify.success(`${result.repositories} repositories.`); })}>
                      {busy === `refresh-${installation.installationId}` ? <Loader size={14} className="spin" /> : <RefreshCw size={14} />} Refresh
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <details>
        <summary>Forget this App</summary>
        <p className="hint">Removes the App from this Stackport. It does not delete it on GitHub (do that in the App's settings), and it is refused while a project still deploys through it.</p>
        <Button type="button" variant="destructive" size="sm" disabled={busy !== ""}
          onClick={() => void run("forget", async () => { await api.forgetGithubApp(); notify.success("The App was forgotten."); })}>
          Forget the App
        </Button>
      </details>
    </div>
  );
}
