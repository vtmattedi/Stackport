import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertCircle, Loader, Star, Trash2 } from "lucide-react";
import { api, ApiError } from "../../api/client";
import type { HostnameOverview, ManagedDomain, ServerAddress } from "../../api/types";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { notify } from "../../lib/notify";

function daysLeft(expiresAt: string | null): string {
  if (!expiresAt) return "";
  const days = Math.ceil((Date.parse(expiresAt) - Date.now()) / 86_400_000);
  return days >= 0 ? `${days} day${days === 1 ? "" : "s"}` : `expired ${-days} day${days === -1 ? "" : "s"} ago`;
}

const DNS_LABEL: Record<ManagedDomain["dnsStatus"], string> = {
  unknown: "not checked",
  ok: "resolves here",
  "not-resolving": "not resolving",
  "points-elsewhere": "points elsewhere",
};

/** The base domains Stackport manages, and every hostname on them. A project's hostname is a label on one of these (or the
 *  bare domain, with www either way); adding a base domain here is what makes the label picker appear on a project. */
export default function DomainsSection() {
  const [domains, setDomains] = useState<ManagedDomain[] | null>(null);
  const [hostnames, setHostnames] = useState<HostnameOverview[]>([]);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState("");
  const [server, setServer] = useState<ServerAddress | null>(null);
  const [address, setAddress] = useState("");

  const load = useCallback(async () => {
    try {
      const [d, h, s] = await Promise.all([api.getManagedDomains(), api.getHostnames(), api.getDomainSettings()]);
      setDomains(d.domains);
      setHostnames(h.hostnames);
      setServer(s.server);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load the domains");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function run(label: string, work: () => Promise<void>) {
    setBusy(label);
    try { await work(); await load(); }
    catch (err) { notify.error(err, "Domains"); }
    finally { setBusy(""); }
  }

  if (error) return <Alert variant="destructive"><AlertCircle size={14} /><AlertDescription>{error}</AlertDescription></Alert>;
  if (!domains) return <Loader size={14} className="spin" />;

  return (
    <>
      <div className="card">
        <p className="hint">
          Add the domains you point at this server. A project's hostname is then a label on one of them (<code className="mono">shop.example.com</code>) or the
          bare domain itself (<code className="mono">example.com</code>, with <code className="mono">www</code> redirecting one way or the other). The default
          is used for the hostname a new project reserves.
        </p>
        <form
          style={{ display: "flex", gap: 8 }}
          onSubmit={(event) => { event.preventDefault(); void run("add", async () => { await api.addManagedDomain(name.trim()); setName(""); notify.success("Domain added."); }); }}
        >
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="example.com" aria-label="Base domain" />
          <Button type="submit" disabled={busy !== "" || !name.trim()}>{busy === "add" ? <Loader size={14} className="spin" /> : null} Add domain</Button>
        </form>
        <div className="field">
          <label>This server's public address</label>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Input value={address} onChange={(event) => setAddress(event.target.value)} placeholder={server?.address ?? "203.0.113.10"} aria-label="Server public address" />
            <Button type="button" variant="outline" disabled={busy !== "" || !address.trim()}
              onClick={() => void run("address", async () => { await api.setServerAddress(address.trim()); setAddress(""); notify.success("Address saved."); })}>Save</Button>
            {server?.setting && <Button type="button" variant="outline" disabled={busy !== ""} onClick={() => void run("address-clear", async () => { await api.setServerAddress(null); })}>Use detected</Button>}
          </div>
          <p className="hint">
            {server?.address
              ? <>DNS checks compare against <code className="mono">{server.address}</code> ({server.source === "setting" ? "entered here" : "detected on this machine"}).</>
              : "Not detected (the server is probably behind NAT). Enter the address your domains should point at; without it DNS cannot be checked and certificates are not held back."}
          </p>
        </div>
        {domains.length === 0 ? (
          <p className="hint">No managed domains yet. Without one, hostnames are typed in full as before.</p>
        ) : (
          <table>
            <thead><tr><th>Domain</th><th>DNS</th><th>Hostnames</th><th /></tr></thead>
            <tbody>
              {domains.map((domain) => (
                <tr key={domain.id}>
                  <td className="mono">{domain.name} {domain.isDefault && <span className="muted-text">(default)</span>}</td>
                  <td title={domain.dnsDetail ?? undefined}>{DNS_LABEL[domain.dnsStatus]}</td>
                  <td>{domain.hostnameCount}</td>
                  <td style={{ display: "flex", gap: 6 }}>
                    <Button type="button" size="sm" variant="outline" disabled={busy !== ""}
                      onClick={() => void run(`check-${domain.id}`, async () => { await api.checkManagedDomain(domain.id); })}>
                      {busy === `check-${domain.id}` ? <Loader size={12} className="spin" /> : null} Check DNS
                    </Button>
                    {!domain.isDefault && (
                      <Button type="button" size="sm" variant="outline" disabled={busy !== ""}
                        onClick={() => void run(`default-${domain.id}`, async () => { await api.setDefaultManagedDomain(domain.id); })}>
                        <Star size={12} /> Make default
                      </Button>
                    )}
                    <Button type="button" size="sm" variant="outline" disabled={busy !== "" || domain.hostnameCount > 0}
                      title={domain.hostnameCount > 0 ? "Hostnames still use this domain" : undefined}
                      onClick={() => void run(`remove-${domain.id}`, async () => { await api.removeManagedDomain(domain.id); notify.success("Domain removed."); })}>
                      <Trash2 size={12} /> Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h4>Hostnames</h4>
        {hostnames.length === 0 ? (
          <p className="hint">No project has a hostname yet.</p>
        ) : (
          <table>
            <thead><tr><th>Hostname</th><th>Project</th><th>Route</th><th>DNS</th><th>SSL</th><th>Certificate</th></tr></thead>
            <tbody>
              {hostnames.map((host) => (
                <tr key={host.id}>
                  <td className="mono">
                    {host.domain}
                    {host.alsoAnswers && <div className="muted-text">{host.alsoAnswers} redirects here</div>}
                    {!host.baseDomain && <div className="muted-text">not on a managed domain</div>}
                  </td>
                  <td><Link to={`/projects/${host.projectId}/domains`}>{host.projectName}</Link></td>
                  <td className="mono">{host.service ? `${host.service}:${host.containerPort}` : <span className="muted-text">pick a service</span>}</td>
                  <td title={host.dnsDetail ?? undefined}>{DNS_LABEL[host.dnsStatus]}</td>
                  <td>{host.useSsl ? "on" : "off"}</td>
                  <td>{host.certificate ? `${host.certificate.status}${host.certificate.expiresAt ? `, ${daysLeft(host.certificate.expiresAt)}` : ""}` : "none"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
