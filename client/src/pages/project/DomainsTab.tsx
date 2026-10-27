import { useState } from "react";
import { AlertTriangle, Globe, Loader, Plus } from "lucide-react";
import { api, ApiError } from "../../api/client";
import type { ActionRecord, Project, ProjectDomain, TcpExposure } from "../../api/types";
import { useConfirm } from "../../components/ConfirmDialog";
import { ExpandableCard } from "../../components/ExpandableCard";
import { NumberInput } from "../../components/NumberInput";
import { ProjectIngressSelect } from "../../components/ProjectIngressSelect";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { jsonEqual, useSystemActions, useSystemSelector } from "../../context/SystemContext";
import { notify } from "../../lib/notify";
import styles from "../ProjectDetails.module.scss";
import { DomainRow, TcpExposureRow } from "./IngressRows";
import { useProjectTcpExposures } from "./useProjectData";

type Updater<T> = T | ((current: T) => T);

/** Domains (routed through nginx, with SSL) and public TCP ports. Changes apply
 *  immediately; nothing here goes through the Settings form. */
export function DomainsTab({ project, setProject, domains, setDomains }: {
  project: Project;
  setProject: (next: Updater<Project | null>) => void;
  domains: ProjectDomain[];
  setDomains: (next: Updater<ProjectDomain[]>) => void;
}) {
  const confirm = useConfirm();
  const { certbotAction, issueProjectDomainSsl } = useSystemActions();
  const [tcpExposures, setTcpExposures] = useProjectTcpExposures(project.id, true);
  const [newDomainInput, setNewDomainInput] = useState("");
  const [newDomainService, setNewDomainService] = useState("");
  const [newDomainPort, setNewDomainPort] = useState("");
  const [addingDomain, setAddingDomain] = useState(false);
  const [domainError, setDomainError] = useState("");
  const [newTcpPublicPort, setNewTcpPublicPort] = useState("");
  const [newTcpService, setNewTcpService] = useState("");
  const [newTcpContainerPort, setNewTcpContainerPort] = useState("");
  const [addingTcpExposure, setAddingTcpExposure] = useState(false);
  const [tcpExposureError, setTcpExposureError] = useState("");
  const domainNames = domains.map((d) => d.domain);
  const certbotInfo = useSystemSelector((snap) => {
    const certbot = snap.system?.certbot;
    return {
      available: !!(certbot?.available && certbot?.emailConfigured),
      entries: (certbot?.entries ?? []).filter((entry) => domainNames.includes(entry.domain)),
    };
  }, jsonEqual);
  const certbotRecords = useSystemSelector(
    (snap) => snap.systemActions.certbot.filter((entry) => domainNames.includes(entry.meta?.["domain"] as string)),
    jsonEqual,
  );

  async function handleCertAction(domain: string, action: "issue" | "renew" | "delete") {
    await certbotAction(domain, action);
  }

  async function addDomain() {
    const port = Number(newDomainPort);
    if (!project || !newDomainInput.trim() || !newDomainService.trim() || !Number.isInteger(port) || port <= 0) return;
    setAddingDomain(true);
    setDomainError("");
    try {
      const created = await api.addProjectDomain(project.id, newDomainInput.trim(), newDomainService.trim(), port);
      setDomains((current) => [...current, created]);
      if (project.healthCheckDomainId === null) {
        setProject((current) => current ? { ...current, healthCheckDomainId: created.id } : current);
      }
      setNewDomainInput("");
      setNewDomainService("");
      setNewDomainPort("");
    } catch (err) {
      setDomainError(err instanceof ApiError ? err.message : "Failed to add domain");
    } finally {
      setAddingDomain(false);
    }
  }

  async function addTcpExposure() {
    const publicPort = Number(newTcpPublicPort);
    const containerPort = Number(newTcpContainerPort);
    if (!project || !Number.isInteger(publicPort) || !newTcpService || !Number.isInteger(containerPort)) return;
    setAddingTcpExposure(true);
    setTcpExposureError("");
    try {
      const created = await api.addTcpExposure(project.id, publicPort, newTcpService, containerPort);
      setTcpExposures((current) => [...current, created].sort((a, b) => a.publicPort - b.publicPort));
      setNewTcpPublicPort("");
      setNewTcpService("");
      setNewTcpContainerPort("");
      notify.success(`TCP port ${publicPort} is exposed.`);
    } catch (err) {
      setTcpExposureError(err instanceof ApiError ? err.message : "Failed to add TCP exposure");
    } finally {
      setAddingTcpExposure(false);
    }
  }

  async function removeTcpExposureRow(exposure: TcpExposure) {
    if (!project) return;
    const ok = await confirm({
      title: `Remove public TCP port ${exposure.publicPort}?`,
      description: `This removes only the StackPort TCP proxy to ${exposure.service}:${exposure.containerPort}.`,
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.removeTcpExposure(project.id, exposure.id);
      setTcpExposures((current) => current.filter((item) => item.id !== exposure.id));
      notify.success(`TCP port ${exposure.publicPort} removed.`);
    } catch (err) {
      notify.error(err, `Failed to remove TCP port ${exposure.publicPort}`);
    }
  }

  async function removeDomainRow(domain: ProjectDomain) {
    if (!project) return;
    const ok = await confirm({
      title: `Remove ${domain.domain}?`,
      description: "This stops routing the domain to this project. Any issued certificate stays on disk untouched.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.removeProjectDomain(project.id, domain.id);
      const remainingDomains = domains.filter((d) => d.id !== domain.id);
      const nextDomainId = project.healthCheckDomainId === domain.id ? remainingDomains[0]?.id ?? null : project.healthCheckDomainId;
      setDomains(remainingDomains);
      setProject((current) => current ? { ...current, healthCheckDomainId: nextDomainId } : current);
    } catch (err) {
      notify.error(err, `Failed to remove ${domain.domain}`);
    }
  }

  async function toggleDomainSsl(domain: ProjectDomain, useSsl: boolean) {
    if (!project) return;
    try {
      const updated = await api.setProjectDomainSsl(project.id, domain.id, useSsl);
      setDomains((current) => current.map((d) => (d.id === domain.id ? updated : d)));
    } catch (err) {
      notify.error(err, `Failed to update SSL for ${domain.domain}`);
    }
  }

  async function issueDomainSsl(domain: ProjectDomain) {
    if (!project) return;
    const final = await issueProjectDomainSsl(project.id, domain.id);
    if (final?.ok) {
      setDomains((current) => current.map((d) => (d.id === domain.id ? { ...d, useSsl: true } : d)));
    }
  }


  function certbotRecordFor(domain: string): ActionRecord | null {
    return certbotRecords
      .filter((entry) => entry.meta?.["domain"] === domain)
      .reduce<ActionRecord | null>((latest, entry) => (
        !latest || new Date(entry.startedAt) > new Date(latest.startedAt) ? entry : latest
      ), null);
  }

  const certbotAvailable = certbotInfo.available;
  function certbotEntryFor(domain: string) {
    return certbotInfo.entries.find((e) => e.domain === domain) ?? null;
  }

  return (
    <>
      {/* ── Domains & ports card (changes apply immediately, not through Save) ── */}
      <ExpandableCard
        icon={<Globe size={13} />}
        title="Domains & ports"
        storageKey="project.ingress"
        defaultOpen
        summary={<span className={styles.cardSummaryText}>{domains.length} domain{domains.length === 1 ? "" : "s"}{tcpExposures.length > 0 ? ` · ${tcpExposures.length} TCP` : ""}</span>}
      >
        <div className={styles.ingressBlock}>
          <div className={styles.historyHeading}>Domains</div>
          <p className="muted-text">Each domain routes to a compose service and container port over the stackport-proxy network.</p>
          <div className="row-actions">
            <Input
              type="text"
              placeholder="myapp.example.com"
              value={newDomainInput}
              onChange={(e) => setNewDomainInput(e.target.value)}
              className={styles.domainInput}
            />
            <ProjectIngressSelect projectId={project.id} composeFile={project.composeFile}
              refreshKey={project.updatedAt} disabled={addingDomain}
              value={newDomainService && newDomainPort ? `${newDomainService}:${newDomainPort}` : ""}
              onValueChange={value => { const [service = "", port = ""] = value.split(":"); setNewDomainService(service); setNewDomainPort(port); }} />
            <Button
              type="button"
              variant="outline"
              size="default"
              onClick={() => void addDomain()}
              disabled={addingDomain || !newDomainInput.trim() || !newDomainService.trim() || !newDomainPort.trim()}
              title={!newDomainInput.trim() ? "Type a domain first" : !newDomainService.trim() ? "Pick the service and port it should reach" : undefined}
            >
              {addingDomain ? <Loader size={12} className="spin" /> : <Plus size={12} />}
              Add domain
            </Button>
          </div>
          {domainError && <div className={styles.inlineError}>{domainError}</div>}
          {domains.length === 0 ? (
            <div className="muted-text">No domains routed to this project.</div>
          ) : (
            <div className={styles.ingressList}>
              {domains.map((domain) => (
                <DomainRow
                  key={domain.id}
                  domain={domain}
                  cert={certbotEntryFor(domain.domain)}
                  certRecord={certbotRecordFor(domain.domain)}
                  certbotAvailable={certbotAvailable}
                  onToggleSsl={(checked) => void toggleDomainSsl(domain, checked)}
                  onIssue={() => void issueDomainSsl(domain)}
                  onCertAction={(action) => void handleCertAction(domain.domain, action)}
                  onRemove={() => void removeDomainRow(domain)}
                />
              ))}
            </div>
          )}
        </div>

        <div className={styles.ingressBlock}>
          <div className={styles.historyHeading}>TCP ports</div>
          <div className={styles.tcpWarningCard} role="note" aria-label="Public TCP security warning">
            <AlertTriangle size={17} />
            <div>
              <strong>Public TCP security boundary</strong>
              <span>Public TCP ports are reachable outside the VPS. Authentication, TLS, and protocol security remain the application's responsibility.</span>
            </div>
          </div>
          <div className="row-actions">
            <NumberInput
              min={1}
              max={65535}
              placeholder="Public port"
              aria-label="Public port"
              value={newTcpPublicPort === "" ? null : Number(newTcpPublicPort)}
              onValueChange={(port) => setNewTcpPublicPort(port == null ? "" : String(port))}
              className={styles.portInput}
            />
            <ProjectIngressSelect projectId={project.id} composeFile={project.composeFile}
              refreshKey={project.updatedAt} disabled={addingTcpExposure}
              value={newTcpService && newTcpContainerPort ? `${newTcpService}:${newTcpContainerPort}` : ""}
              onValueChange={value => { const [service = "", port = ""] = value.split(":"); setNewTcpService(service); setNewTcpContainerPort(port); }} />
            <Button type="button" variant="outline" size="default" onClick={() => void addTcpExposure()}
              disabled={addingTcpExposure || !newTcpPublicPort || !newTcpService || !newTcpContainerPort}
              title={!newTcpPublicPort ? "Type a public port first" : !newTcpService ? "Pick the service and port it should reach" : undefined}>
              {addingTcpExposure ? <Loader size={12} className="spin" /> : <Plus size={12} />}
              Expose
            </Button>
          </div>
          {tcpExposureError && <div className={styles.inlineError}>{tcpExposureError}</div>}
          {tcpExposures.length === 0 ? (
            <div className="muted-text">No public TCP ports configured.</div>
          ) : (
            <div className={styles.ingressList}>
              {tcpExposures.map((exposure) => (
                <TcpExposureRow key={exposure.id} exposure={exposure} onRemove={() => void removeTcpExposureRow(exposure)} />
              ))}
            </div>
          )}
        </div>
      </ExpandableCard>

    </>
  );
}
