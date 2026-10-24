import { Loader, Lock, RefreshCw, Trash2 } from "lucide-react";
import type { ActionRecord, CertbotEntry, ProjectDomain, TcpExposure } from "../../api/types";
import { Button } from "../../components/ui/button";
import { Switch } from "../../components/ui/switch";
import { formatShortDateTime } from "../../lib/format";
import { cn } from "../../lib/utils";
import styles from "../ProjectDetails.module.scss";

/** One routed domain: where it points, its certificate, SSL toggle and cert actions. */
export function DomainRow({ domain, cert, certRecord, certbotAvailable, onToggleSsl, onIssue, onCertAction, onRemove }: {
  domain: ProjectDomain;
  cert: CertbotEntry | null;
  certRecord: ActionRecord | null;
  certbotAvailable: boolean;
  onToggleSsl: (checked: boolean) => void;
  onIssue: () => void;
  onCertAction: (action: "renew" | "delete") => void;
  onRemove: () => void;
}) {
  const acting = certRecord?.status === "running";
  const needsCert = !cert || cert.status === "missing" || cert.status === "expired";
  return (
    <div className={styles.ingressRow}>
      <div className={styles.ingressRowHead}>
        <span className="mono">{domain.domain}</span>
        <span className={cn("mono", styles.ingressTarget)}>
          {domain.service ? `→ ${domain.service}:${domain.containerPort}` : "not routed"}
        </span>
        {cert ? (
          <span className={cn(styles.statusPill,
            cert.status === "valid" ? styles.statusUp : cert.status === "expiring" ? styles.statusUnknown : styles.statusDown)}>
            {cert.status}
            {cert.expiresAt && ` · ${formatShortDateTime(cert.expiresAt, "")}`}
          </span>
        ) : (
          <span className={cn(styles.statusPill, styles.statusDown)}>no cert</span>
        )}
        <label className={cn(styles.sslToggle, !certbotAvailable && styles.sslToggleDisabled)}
          title={certbotAvailable ? undefined : "Certbot isn't available on this server"}>
          <Switch checked={domain.useSsl} onCheckedChange={onToggleSsl} disabled={!certbotAvailable} />
          <span>Use SSL</span>
        </label>
      </div>
      <div className="row-actions">
        {certbotAvailable && needsCert ? (
          <Button type="button" size="xs" onClick={onIssue} disabled={acting}>
            {acting ? <Loader size={12} className="spin" /> : <Lock size={12} />}
            Issue cert
          </Button>
        ) : certbotAvailable && (
          <Button type="button" variant="outline" size="xs" onClick={() => onCertAction("renew")} disabled={acting}>
            {acting ? <Loader size={12} className="spin" /> : <RefreshCw size={12} />}
            Renew
          </Button>
        )}
        {cert && (
          <Button type="button" variant="outline" size="xs" className={styles.dangerAction} onClick={() => onCertAction("delete")} disabled={acting}>
            <Trash2 size={12} />
            Remove cert
          </Button>
        )}
        <Button type="button" variant="outline" size="xs" className={styles.dangerAction} onClick={onRemove}>
          <Trash2 size={12} />
          Remove domain
        </Button>
      </div>
      {certRecord?.log && <pre className="output-block">{certRecord.log}</pre>}
    </div>
  );
}

/** One public TCP port passed through to a compose service. */
export function TcpExposureRow({ exposure, onRemove }: { exposure: TcpExposure; onRemove: () => void }) {
  return (
    <div className={styles.ingressRow}>
      <div className={styles.ingressRowHead}>
        <span className="mono">:{exposure.publicPort}</span>
        <span className={cn("mono", styles.ingressTarget)}>→ {exposure.service}:{exposure.containerPort}</span>
        {exposure.lastError
          ? <span className={cn(styles.statusPill, styles.statusDown)} title={exposure.lastError}>error</span>
          : <span className={cn(styles.statusPill, styles.statusUp)}>configured</span>}
        <Button type="button" variant="outline" size="xs" className={cn(styles.dangerAction, styles.pushRight)} onClick={onRemove}>
          <Trash2 size={12} /> Remove
        </Button>
      </div>
      {exposure.lastError && <div className={styles.inlineError}>{exposure.lastError}</div>}
    </div>
  );
}
