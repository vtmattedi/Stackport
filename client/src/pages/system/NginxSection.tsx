import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertCircle, Eye, FileText, Layers, Loader, RefreshCw, RotateCw, Save, Settings } from "lucide-react";
import { api, ApiError } from "../../api/client";
import type { NginxDocument, NginxDocumentKind } from "../../api/types";
import { Disclosure } from "../../components/Disclosure";
import NginxCode from "../../components/NginxCode";
import { ServiceError } from "../../components/ServiceError";
import { StatusChip } from "../../components/StatusChip";
import { SubShellSectionHeader } from "../../components/SubShell";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Stack } from "../../components/ui/stack";
import { Tabs, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { Hint, Prose } from "../../components/ui/text";
import { useSystem } from "../../context/SystemContext";
import { formatShortDateTime } from "../../lib/format";
import { notify } from "../../lib/notify";
import { OutputBlock } from "./OutputBlock";
import styles from "../System.module.scss";

const NGINX_DOC_KEY = "stackport_system_nginx_doc";

function readDocumentKind(): NginxDocumentKind {
  try {
    const value = localStorage.getItem(NGINX_DOC_KEY);
    if (value === "generated" || value === "failed" || value === "general" || value === "project") return value;
    if (value === "fixed") return "general";
    if (value === "domain") return "project";
    return "generated";
  } catch {
    return "generated";
  }
}

/** Host > Nginx: what is published through it, whether the last config applied, and (folded away) the files. */
export function NginxSection() {
  const { system: data, refreshSystem: refresh, applyNginx } = useSystem();
  const nginx = data?.nginx;
  const layer = nginx?.layer;

  const [docKind, setDocKind] = useState<NginxDocumentKind>(() => readDocumentKind());
  const [filesOpen, setFilesOpen] = useState(false);
  const [doc, setDoc] = useState<NginxDocument | null>(null);
  const [docDraft, setDocDraft] = useState("");
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [savingDoc, setSavingDoc] = useState(false);
  const [docResult, setDocResult] = useState<{ ok: boolean; output: string } | null>(null);
  const [reloading, setReloading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [reloadResult, setReloadResult] = useState<{ ok: boolean; output: string } | null>(null);

  useEffect(() => {
    try { localStorage.setItem(NGINX_DOC_KEY, docKind); } catch { /* a remembered tab is a convenience */ }
  }, [docKind]);

  useEffect(() => {
    if (filesOpen) void loadDocument(docKind);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when the file kind changes or the editor is opened
  }, [docKind, filesOpen]);

  useEffect(() => {
    if (docKind === "failed" && layer && !layer.failedConfigExists) setDocKind("generated");
  }, [layer, docKind]);

  async function loadDocument(kind: NginxDocumentKind = docKind) {
    setLoadingDoc(true);
    setDocResult(null);
    try {
      const document = await api.getNginxDocument(kind);
      setDoc(document);
      setDocDraft(document.content);
    } catch (err) {
      setDocResult({ ok: false, output: err instanceof ApiError ? err.message : "Failed to load nginx file" });
    } finally {
      setLoadingDoc(false);
    }
  }

  async function saveTemplate() {
    if (docKind !== "general" && docKind !== "project") return;
    const toastId = notify.loading(`Saving ${docKind} template...`);
    setSavingDoc(true);
    setApplying(true);
    setDocResult(null);
    setReloadResult(null);
    try {
      const document = await api.updateNginxTemplate(docKind, docDraft);
      setDoc(document);
      setDocDraft(document.content);
      notify.success(`Saved ${document.path}.`, { id: toastId });
      const final = await applyNginx();
      const ok = final?.ok ?? false;
      setDocResult({ ok, output: `Saved ${document.path}` });
      setReloadResult({ ok, output: [`saved: ${document.path}`, final?.log ?? ""].filter(Boolean).join("\n") });
      refresh();
      void loadDocument("generated");
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Failed to save nginx template";
      setDocResult({ ok: false, output: message });
      notify.error(err, "Failed to save nginx template", { id: toastId });
    } finally {
      setSavingDoc(false);
      setApplying(false);
    }
  }

  async function reload() {
    const toastId = notify.loading("Reloading nginx...");
    setReloading(true);
    setReloadResult(null);
    try {
      const result = await api.reloadNginx();
      setReloadResult(result);
      if (result.ok) {
        notify.success("Nginx reloaded.", { id: toastId });
        refresh();
      } else {
        notify.error(new Error(result.output || "Reload failed"), "Nginx reload failed", { id: toastId });
      }
    } catch (err) {
      setReloadResult({ ok: false, output: err instanceof ApiError ? err.message : "Reload failed" });
      notify.error(err, "Nginx reload failed", { id: toastId });
    } finally {
      setReloading(false);
    }
  }

  async function apply() {
    setApplying(true);
    setReloadResult(null);
    try {
      const final = await applyNginx();
      setReloadResult(final ? { ok: final.ok ?? false, output: final.log } : { ok: false, output: "Apply failed" });
      refresh();
      if (docKind === "generated" && filesOpen) void loadDocument("generated");
    } finally {
      setApplying(false);
    }
  }

  const applied = !!layer?.lastOperation;
  const routes = layer?.routes ?? [];

  return (
    <>
      <SubShellSectionHeader
        title="Nginx"
        icon={Layers}
        meta={(
          <>
            {nginx?.version && <span className="mono muted-text">{nginx.version}</span>}
            {nginx?.available !== undefined && <StatusChip ok={!!nginx.available} labels={["available", "unavailable"]} />}
            {nginx?.available && nginx.active !== undefined && <StatusChip ok={nginx.active} labels={["active", "inactive"]} />}
          </>
        )}
        description="Runs in the stackport-nginx container and routes every project's hostnames."
        actions={nginx?.available && (
          <>
            <Button type="button" variant="outline" size="xs" onClick={() => void apply()} disabled={applying || reloading} title="Generate the config from the projects, check it, and reload">
              {applying ? <Loader size={12} className="spin" /> : <FileText size={12} />}
              Apply
            </Button>
            <Button type="button" variant="outline" size="xs" onClick={() => void reload()} disabled={reloading || applying} title="Reload nginx with the config it has">
              {reloading ? <Loader size={12} className="spin" /> : <RotateCw size={12} />}
              Reload
            </Button>
          </>
        )}
      />
      {!nginx ? (
        <Loader size={14} className="spin" />
      ) : !nginx.available ? (
        <ServiceError service="Nginx" reason={nginx.reason} />
      ) : (
        <Stack gap={4}>
          {layer && (
            <div className="card mb-0!">
              <div className="card-title">Published routes<span className="ml-2 font-normal normal-case">{routes.length}</span></div>
              <Stack gap={3}>
                {routes.length === 0 ? (
                  <Hint>No hostname is routed to a project yet. Add one on a project's Domains tab.</Hint>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead><tr><th>Hostname</th><th>Project</th><th>Goes to</th></tr></thead>
                      <tbody>
                        {routes.map((route) => (
                          <tr key={`${route.project}:${route.domain}:${route.port}`}>
                            <td className="mono">{route.domain}</td>
                            <td>{route.project}</td>
                            <td className="mono">{route.service}:{route.port}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <Hint>
                  {layer.app.enabled && layer.app.domain
                    ? <>Stackport itself is served at <span className="mono">{layer.app.domain}</span>{layer.app.useSsl ? " over HTTPS" : " over plain HTTP"}. Change it in <Link to="/settings/domains">Settings &gt; Domains</Link>.</>
                    : <>Stackport itself is not served on a hostname. Set one up in <Link to="/settings/domains">Settings &gt; Domains</Link>.</>}
                </Hint>
              </Stack>
            </div>
          )}

          <div className="card mb-0!">
            <div className="card-title">Config</div>
            <Stack gap={3}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                {applied
                  ? <StatusChip ok={layer!.lastOperation!.ok} labels={["last apply worked", "last apply failed"]} />
                  : <Badge variant="outline" className="text-[var(--dim)]">not applied yet</Badge>}
                {layer?.lastOperation && (
                  <span className="text-xs text-[var(--dim)]">{formatShortDateTime(layer.lastOperation.updatedAt)} · {layer.lastOperation.restartCount} {layer.lastOperation.restartCount === 1 ? "restart" : "restarts"}</span>
                )}
                {nginx.configTest && (applied || nginx.configTest.ok) && <StatusChip ok={nginx.configTest.ok} labels={["config test passes", "config test fails"]} />}
              </div>
              {!applied && <Hint>Nothing has been generated since Stackport started. Apply builds the config from the projects, checks it, and reloads Nginx.</Hint>}
              {layer?.lastOperation?.output && (
                <Disclosure title="Output of the last apply" meta={layer.lastOperation.ok ? undefined : "failed"}>
                  <pre className={`output-block${layer.lastOperation.ok ? "" : " output-stderr"}`} style={{ fontSize: "0.76em" }}>{layer.lastOperation.output}</pre>
                </Disclosure>
              )}
              {nginx.configTest?.output && applied && (
                <Disclosure title="Output of the config test">
                  <pre className="output-block" style={{ fontSize: "0.78em" }}>{nginx.configTest.output}</pre>
                </Disclosure>
              )}
              {reloadResult && <OutputBlock output={reloadResult.output} ok={reloadResult.ok} onDismiss={() => setReloadResult(null)} />}
            </Stack>
          </div>

          {layer && (
            <Disclosure title="Where the files are" meta="paths and backups">
              <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[max-content_1fr]">
                {([
                  ["Generated config", layer.targetPath],
                  ["General template", layer.generalTemplatePath ?? layer.fixedBlockPath],
                  ["Project template", layer.projectTemplatePath ?? layer.domainTemplatePath],
                  ["Backups", `${layer.backupCount} in ${layer.backupDir}`],
                ] as const).map(([name, value]) => (
                  <div key={name} className="contents">
                    <dt className="text-xs text-[var(--dim)]">{name}</dt>
                    <dd className="mono break-all">{value}</dd>
                  </div>
                ))}
              </dl>
            </Disclosure>
          )}

          <Disclosure title="Nginx files" meta={docKind} open={filesOpen} onOpenChange={setFilesOpen}>
            <Stack gap={3}>
              <Prose>Look at what was generated, or edit the templates the config is generated from. Saving a template applies it.</Prose>
              <div className={styles.nginxDocHeader}>
                <Tabs value={docKind} onValueChange={(value) => setDocKind(value as NginxDocumentKind)}>
                  <TabsList className={styles.nginxDocTabs}>
                    <TabsTrigger value="generated" title="Inspect generated sites-available/default"><Eye size={12} />Generated</TabsTrigger>
                    {layer?.failedConfigExists && (
                      <TabsTrigger value="failed" className={styles.failedDocTab} title="Inspect the last generated config that failed validation or reload"><AlertCircle size={12} />Failed</TabsTrigger>
                    )}
                    <TabsTrigger value="general" title="Edit the general config template"><Settings size={12} />General</TabsTrigger>
                    <TabsTrigger value="project" title="Edit the per-project block template"><FileText size={12} />Project</TabsTrigger>
                  </TabsList>
                </Tabs>
                <div className="row-actions">
                  <Button type="button" variant="outline" size="xs" onClick={() => void loadDocument()} disabled={loadingDoc} title="Reload file content">
                    {loadingDoc ? <Loader size={12} className="spin" /> : <RefreshCw size={12} />}
                    Reload
                  </Button>
                  {doc?.editable && (
                    <Button type="button" variant="outline" size="xs" onClick={() => void saveTemplate()} disabled={savingDoc || docDraft === doc.content} title="Save template">
                      {savingDoc ? <Loader size={12} className="spin" /> : <Save size={12} />}
                      Save
                    </Button>
                  )}
                </div>
              </div>
              <div className={styles.nginxDocMeta}>
                <span className="mono path-text">{doc?.path ?? "No file loaded"}</span>
                {doc?.sizeBytes != null && <span className="mono">{doc.sizeBytes} bytes</span>}
                {doc?.updatedAt && <span className="mono">{formatShortDateTime(doc.updatedAt)}</span>}
              </div>
              {loadingDoc ? (
                <div className="empty" style={{ padding: 18 }}><Loader size={16} className="spin" /></div>
              ) : doc?.editable ? (
                <NginxCode value={docDraft} mode="editable" onChange={setDocDraft} />
              ) : (
                <NginxCode value={docDraft} mode="view" />
              )}
              {docResult && <OutputBlock output={docResult.output} ok={docResult.ok} onDismiss={() => setDocResult(null)} />}
            </Stack>
          </Disclosure>
        </Stack>
      )}
    </>
  );
}
