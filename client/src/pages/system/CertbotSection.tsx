import { useEffect, useMemo, useState } from "react";
import { KeyRound, Loader, Mail, RotateCw, Save, ShieldCheck, Trash2 } from "lucide-react";
import { api, ApiError } from "../../api/client";
import type { CertbotEntry } from "../../api/types";
import { useConfirm } from "../../components/ConfirmDialog";
import { Disclosure } from "../../components/Disclosure";
import { ServiceError } from "../../components/ServiceError";
import { StatusChip } from "../../components/StatusChip";
import { SubShellSectionHeader } from "../../components/SubShell";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Field } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { Stack } from "../../components/ui/stack";
import { Hint, Prose } from "../../components/ui/text";
import { useSystem } from "../../context/SystemContext";
import { formatShortDateTime } from "../../lib/format";
import { notify } from "../../lib/notify";
import { OutputBlock } from "./OutputBlock";

type Op = "issue" | "renew" | "delete";
type State = "expired" | "expiring" | "missing" | "unknown" | "valid";

const DAY_MS = 24 * 60 * 60 * 1000;

function stateOf(entry: CertbotEntry): State {
  if (!entry.hasCertificate) return "missing";
  if (entry.status === "expired") return "expired";
  if (entry.status === "expiring") return "expiring";
  if (entry.status === "unknown") return "unknown";
  return "valid";
}

/** Most urgent first: what is broken, then what is about to be, then what is fine. */
const URGENCY: Record<State, number> = { expired: 0, expiring: 1, missing: 2, unknown: 3, valid: 4 };

const BADGE_CLASS: Record<State, string> = {
  expired: "border-[var(--danger)] text-[var(--danger)]",
  expiring: "border-[var(--warning,#d29922)] text-[var(--warning,#d29922)]",
  missing: "text-[var(--dim)]",
  unknown: "text-[var(--dim)]",
  valid: "border-[var(--success)] text-[var(--success)]",
};

function expiryText(entry: CertbotEntry): string {
  if (!entry.hasCertificate) return "No certificate yet";
  if (!entry.expiresAt) return "End date unknown";
  const days = Math.floor((Date.parse(entry.expiresAt) - Date.now()) / DAY_MS);
  if (days < 0) return `Ended ${-days} ${-days === 1 ? "day" : "days"} ago`;
  if (days === 0) return "Ends today";
  return `Ends in ${days} ${days === 1 ? "day" : "days"}`;
}

/** Host > Certbot: which hostnames have a certificate and when it ends. Certificates are issued when a hostname is routed and renewed by
 *  a background check, so the buttons here are for when one needs a hand. */
export function CertbotSection() {
  const { system: data, refreshSystem: refresh, certbotAction } = useSystem();
  const confirm = useConfirm();
  const certbot = data?.certbot;
  const [ops, setOps] = useState<Record<string, { op: Op | null; result: { ok: boolean; output: string } | null }>>({});
  const [emailDraft, setEmailDraft] = useState("");
  const [emailDirty, setEmailDirty] = useState(false);
  const [savingEmail, setSavingEmail] = useState(false);

  useEffect(() => {
    if (!emailDirty) setEmailDraft(certbot?.email ?? "");
  }, [certbot?.email, emailDirty]);

  const entries = useMemo(
    () => [...(certbot?.entries ?? [])].sort((a, b) => URGENCY[stateOf(a)] - URGENCY[stateOf(b)] || a.domain.localeCompare(b.domain)),
    [certbot?.entries],
  );
  const counts = entries.reduce<Record<State, number>>((acc, entry) => { acc[stateOf(entry)] += 1; return acc; }, { expired: 0, expiring: 0, missing: 0, unknown: 0, valid: 0 });

  async function run(domain: string, op: Op) {
    if (op === "delete") {
      const ok = await confirm({
        title: `Delete the certificate for ${domain}?`,
        description: "The hostname stops serving HTTPS until a new certificate is issued.",
        confirmLabel: "Delete",
        destructive: true,
      });
      if (!ok) return;
    }
    setOps((prev) => ({ ...prev, [domain]: { op, result: null } }));
    const final = await certbotAction(domain, op);
    const result = final ? { ok: final.ok ?? false, output: final.log } : { ok: false, output: "Certbot action failed" };
    setOps((prev) => ({ ...prev, [domain]: { op: null, result } }));
    refresh();
  }

  async function saveEmail() {
    setSavingEmail(true);
    try {
      const result = await api.updateCertbotEmail(emailDraft);
      setEmailDraft(result.email);
      setEmailDirty(false);
      notify.success(result.emailConfigured ? "Certificate email saved." : "Certificate email cleared.");
      refresh();
    } catch (err) {
      notify.error(err instanceof ApiError ? new Error(err.message) : err, "Could not save the certificate email");
    } finally {
      setSavingEmail(false);
    }
  }

  const emailField = (
    <Stack gap={2}>
      <Field label={<><Mail size={12} className="self-center" />Certificate email</>} htmlFor="certbot-email" hint="Let's Encrypt writes here when a certificate is about to expire.">
        <div className="flex max-w-md gap-2">
          <Input id="certbot-email" type="email" value={emailDraft} placeholder="admin@example.com" onChange={(event) => { setEmailDraft(event.target.value); setEmailDirty(true); }} />
          <Button type="button" variant="outline" disabled={savingEmail || emailDraft.trim() === (certbot?.email ?? "")} onClick={() => void saveEmail()}>
            {savingEmail ? <Loader size={13} className="spin" /> : <Save size={13} />} Save
          </Button>
        </div>
      </Field>
    </Stack>
  );

  return (
    <>
      <SubShellSectionHeader
        title="Certbot"
        icon={ShieldCheck}
        meta={certbot && <StatusChip ok={certbot.available} labels={["available", "unavailable"]} />}
        description="Certificates for the hostnames you route. They are issued when a hostname is set up and renewed automatically; this page is for when one needs a hand."
      />
      {!certbot ? (
        <Loader size={14} className="spin" />
      ) : !certbot.available ? (
        <ServiceError service="Certbot" reason={certbot.reason} />
      ) : (
        <Stack gap={4}>
          {!certbot.emailConfigured && (
            <Alert>
              <Mail size={14} />
              <AlertTitle>Set a certificate email to issue certificates</AlertTitle>
              <AlertDescription><div className="mt-2">{emailField}</div></AlertDescription>
            </Alert>
          )}

          {entries.length === 0 ? (
            <div className="card mb-0!"><Hint>No hostname is routed yet. Add one on a project's Domains tab, or under Settings &gt; Domains.</Hint></div>
          ) : (
            <div className="card mb-0!">
              <Stack gap={3}>
                <Prose>
                  {entries.length} {entries.length === 1 ? "hostname" : "hostnames"}
                  {(["valid", "expiring", "expired", "missing"] as const).filter((state) => counts[state] > 0).map((state) => ` · ${counts[state]} ${state}`).join("")}
                </Prose>
                <ul>
                  {entries.map((entry) => {
                    const state = stateOf(entry);
                    const current = ops[entry.domain] ?? { op: null, result: null };
                    const busy = current.op !== null;
                    const needsHand = state === "expired" || state === "expiring";
                    return (
                      <li key={entry.domain} className="border-b border-border py-3 last:border-b-0">
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                          <div className="grid min-w-0 flex-1 basis-64 gap-1">
                            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                              <span className="mono break-all" title={entry.path ?? undefined}>{entry.domain}</span>
                              <Badge variant="outline" className={BADGE_CLASS[state]}>{state}</Badge>
                              {entry.type === "subdomain" && <span className="text-xs text-[var(--dim)]">subdomain</span>}
                            </div>
                            <div className="text-xs text-[var(--dim)]" title={entry.expiresAt ? formatShortDateTime(entry.expiresAt) : undefined}>
                              {expiryText(entry)}{entry.issuer ? ` · ${entry.issuer}` : ""}
                            </div>
                          </div>
                          <div className="flex gap-1.5">
                            {state === "missing" ? (
                              <Button type="button" size="xs" disabled={busy || !certbot.emailConfigured} title={certbot.emailConfigured ? undefined : "Set a certificate email first"} onClick={() => void run(entry.domain, "issue")}>
                                {current.op === "issue" ? <Loader size={12} className="spin" /> : <KeyRound size={12} />} Issue
                              </Button>
                            ) : (
                              <>
                                <Button type="button" size="xs" variant={needsHand ? "default" : "outline"} disabled={busy} onClick={() => void run(entry.domain, "renew")}>
                                  {current.op === "renew" ? <Loader size={12} className="spin" /> : <RotateCw size={12} />} Renew
                                </Button>
                                <Button type="button" size="icon-xs" variant="ghost" disabled={busy} title="Delete the certificate" aria-label={`Delete the certificate for ${entry.domain}`} onClick={() => void run(entry.domain, "delete")}>
                                  {current.op === "delete" ? <Loader size={12} className="spin" /> : <Trash2 size={12} />}
                                </Button>
                              </>
                            )}
                          </div>
                        </div>
                        {current.result && (
                          <div className="mt-2">
                            <OutputBlock output={current.result.output} ok={current.result.ok} onDismiss={() => setOps((prev) => ({ ...prev, [entry.domain]: { op: null, result: null } }))} />
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </Stack>
            </div>
          )}

          {certbot.emailConfigured && (
            <Disclosure title="Certificate email" meta={certbot.email ?? undefined}>{emailField}</Disclosure>
          )}
        </Stack>
      )}
    </>
  );
}
