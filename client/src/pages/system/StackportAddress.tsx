import { useEffect, useState } from "react";
import { KeyRound, Loader, Radio, RotateCw, Save, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";
import type { NginxAppConfig } from "../../api/types";
import { useConfirm } from "../../components/ConfirmDialog";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { CheckRow, Field } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { Stack } from "../../components/ui/stack";
import { Switch } from "../../components/ui/switch";
import { Hint, Prose } from "../../components/ui/text";
import { useSystem } from "../../context/SystemContext";
import { formatShortDateTime } from "../../lib/format";
import { OutputBlock } from "./OutputBlock";

/** Where Stackport itself is reachable: a hostname Nginx serves it on, with or without HTTPS. GitHub needs this to deliver webhooks and
 *  to send people back after registering the App, so it lives with the other domain settings. */
export function StackportAddress() {
  const { system: data, refreshSystem: refresh, updateNginxAppConfig, certbotAction } = useSystem();
  const confirm = useConfirm();
  const nginx = data?.nginx;
  const certbot = data?.certbot;
  const app = nginx?.layer?.app;

  const [enabled, setEnabled] = useState(false);
  const [domain, setDomain] = useState("");
  const [useSsl, setUseSsl] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ ok: boolean; output: string } | null>(null);
  const [certOp, setCertOp] = useState<"issue" | "renew" | "delete" | null>(null);
  const [certResult, setCertResult] = useState<{ ok: boolean; output: string } | null>(null);

  const changed = dirty && (!app || enabled !== app.enabled || domain !== app.domain || useSsl !== app.useSsl);

  useEffect(() => {
    if (changed || !app) return;
    setEnabled(app.enabled);
    setDomain(app.domain);
    setUseSsl(app.useSsl);
    setDirty(false);
  }, [app, changed]);

  async function save() {
    setSaving(true);
    setSaveResult(null);
    try {
      const final = await updateNginxAppConfig({ enabled, domain, useSsl });
      const saved = final?.meta?.["app"] as NginxAppConfig | undefined;
      if (saved) {
        setEnabled(saved.enabled);
        setDomain(saved.domain);
        setUseSsl(saved.useSsl);
        setDirty(false);
      }
      setSaveResult({
        ok: final?.ok ?? false,
        output: [`hostname: ${saved?.domain || "none"}`, `port: ${saved?.port ?? "-"}`, `enabled: ${saved?.enabled ? "yes" : "no"}`, `https: ${saved?.useSsl ? "yes" : "no"}`, final?.log ?? ""].filter(Boolean).join("\n"),
      });
      refresh();
    } finally {
      setSaving(false);
    }
  }

  async function runCert(op: "issue" | "renew" | "delete") {
    if (!app?.domain) return;
    if (op === "delete") {
      const ok = await confirm({ title: `Delete the certificate for ${app.domain}?`, description: "Stackport stops serving HTTPS on this hostname until a new certificate is issued.", confirmLabel: "Delete", destructive: true });
      if (!ok) return;
    }
    setCertOp(op);
    setCertResult(null);
    const final = await certbotAction(app.domain, op);
    setCertResult(final ? { ok: final.ok ?? false, output: final.log } : { ok: false, output: "Certbot action failed" });
    setCertOp(null);
    refresh();
  }

  const certEntry = certbot?.entries.find((entry) => entry.domain === app?.domain) ?? null;
  const showCert = !!app?.enabled && !!app.domain && app.useSsl;

  return (
    <div className="card mb-0!">
      <div className="card-title"><Radio size={13} />Stackport's own address</div>
      {!nginx?.available || !app ? (
        <Hint>Nginx is not running, so this cannot be changed. See <Link to="/host/nginx">Host &gt; Nginx</Link>.</Hint>
      ) : (
        <Stack gap={4}>
          <Prose>Serve Stackport itself on a hostname, so you can open it by name and so GitHub can deliver webhooks to it.</Prose>
          <CheckRow
            control={<Switch checked={enabled} onCheckedChange={(value) => { setEnabled(value); setDirty(true); }} />}
            title="Serve Stackport at a hostname"
            hint={`Nginx forwards the hostname to this server's port ${app.port}. While this is on, projects cannot use that port.`}
          />
          <Field label="Hostname" htmlFor="stackport-hostname" hint="Create its DNS record yourself. Stackport does not check it." className="max-w-md">
            <Input id="stackport-hostname" type="text" placeholder="stackport.example.com" value={domain} onChange={(event) => { setDomain(event.target.value); setDirty(true); }} />
          </Field>
          <CheckRow
            control={<Switch checked={useSsl} onCheckedChange={(value) => { setUseSsl(value); setDirty(true); }} />}
            title="Use HTTPS"
            hint="When a certificate exists, Nginx serves Stackport over HTTPS and redirects HTTP."
          />
          {showCert && (
            <Stack gap={2}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <Badge variant="outline">{certEntry ? certEntry.status : "no certificate"}</Badge>
                <span className="text-xs text-[var(--dim)]">{certEntry?.expiresAt ? `Ends ${formatShortDateTime(certEntry.expiresAt)}` : "Not issued yet"}</span>
                <div className="flex gap-1.5">
                  <Button type="button" size="xs" variant={certEntry?.hasCertificate ? "outline" : "default"} disabled={certOp !== null || !!certEntry?.hasCertificate || !certbot?.emailConfigured}
                    title={certbot?.emailConfigured ? undefined : "Set a certificate email on Host > Certbot first"} onClick={() => void runCert("issue")}>
                    {certOp === "issue" ? <Loader size={12} className="spin" /> : <KeyRound size={12} />} Issue certificate
                  </Button>
                  <Button type="button" size="xs" variant="outline" disabled={certOp !== null || !certEntry?.hasCertificate} onClick={() => void runCert("renew")}>
                    {certOp === "renew" ? <Loader size={12} className="spin" /> : <RotateCw size={12} />} Renew
                  </Button>
                  <Button type="button" size="icon-xs" variant="ghost" disabled={certOp !== null || !certEntry?.hasCertificate} title="Delete the certificate" aria-label="Delete the certificate" onClick={() => void runCert("delete")}>
                    {certOp === "delete" ? <Loader size={12} className="spin" /> : <Trash2 size={12} />}
                  </Button>
                </div>
              </div>
              {certResult && <OutputBlock output={certResult.output} ok={certResult.ok} onDismiss={() => setCertResult(null)} />}
            </Stack>
          )}
          <div>
            <Button type="button" disabled={saving || !changed || (enabled && !domain.trim())} onClick={() => void save()}>
              {saving ? <Loader size={14} className="spin" /> : <Save size={14} />} Save
            </Button>
          </div>
          {saveResult && <OutputBlock output={saveResult.output} ok={saveResult.ok} onDismiss={() => setSaveResult(null)} />}
        </Stack>
      )}
    </div>
  );
}
