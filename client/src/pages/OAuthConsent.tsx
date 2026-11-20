import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Loader, ShieldCheck } from "lucide-react";
import { AppSelect } from "../components/AppSelect";
import { Button } from "../components/ui/button";
import { CheckRow, Field } from "../components/ui/field";
import { Stack } from "../components/ui/stack";
import { Switch } from "../components/ui/switch";
import { Hint, Prose } from "../components/ui/text";
import { api } from "../api/client";
import type { OAuthRequestInfo } from "../api/types";
import { notify } from "../lib/notify";

const ACCESS_OPTIONS = [
  { value: "read", label: "Read only" },
  { value: "write", label: "Read and write" },
];

const ALL_PROJECTS = "";

/** Where an MCP client sends the admin to approve it (OAuth, server: modules/identity/oauth). The admin chooses what the client may do; the client cannot ask for more. */
export default function OAuthConsent() {
  const [params] = useSearchParams();
  const requestId = params.get("request") ?? "";
  const [info, setInfo] = useState<OAuthRequestInfo | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [access, setAccess] = useState("read");
  const [logs, setLogs] = useState(false);
  const [group, setGroup] = useState(ALL_PROJECTS);
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [recognised, setRecognised] = useState(false);

  useEffect(() => {
    if (!requestId) { setProblem("This page opens from an MCP client. Start the connection from the client."); return; }
    let live = true;
    api.getOAuthRequest(requestId)
      .then((result) => { if (live) setInfo(result); })
      .catch((err) => { if (live) setProblem(err instanceof Error ? err.message : "The request could not be loaded."); });
    return () => { live = false; };
  }, [requestId]);

  async function answer(kind: "approve" | "deny") {
    setBusy(kind);
    try {
      const { redirectUrl } = kind === "approve"
        ? await api.approveOAuthRequest(requestId, { scope: access === "write" ? "write" : "read", logs, projectGroup: (access === "write" || logs) && group !== ALL_PROJECTS ? group : null, ...(info && !info.local ? { confirmHost: info.redirectHost } : {}) })
        : await api.denyOAuthRequest(requestId);
      // Back to the client, which finishes the exchange. Never follow anything that is not https, a local address or an app link.
      if (/^(?:javascript|data|vbscript|file|blob):/i.test(redirectUrl.trim())) throw new Error("The client's redirect address is not allowed.");
      window.location.assign(redirectUrl);
    } catch (err) {
      notify.error(err, kind === "approve" ? "Couldn't approve the connection" : "Couldn't deny the connection");
      setBusy(null);
    }
  }

  return (
    <main className="main">
      <div className="card" style={{ maxWidth: 560, margin: "48px auto" }}>
        <div className="card-title"><ShieldCheck size={13} />Connect an MCP client</div>
        {problem ? (
          <Prose>{problem}</Prose>
        ) : !info ? (
          <div className="empty" style={{ padding: 24 }}><Loader size={20} className="spin" /></div>
        ) : (
          <Stack gap={4}>
            <Prose><strong>{info.clientName}</strong> wants to use this Stackport through MCP.</Prose>
            <div className="alert mb-0!" style={{ display: "grid", gap: 6 }}>
              <strong>The name above was chosen by the client and is not verified.</strong>
              <span>{info.local ? "This client runs on this computer." : <>Your approval will be sent to <span className="mono">{info.redirectHost}</span>.</>}</span>
              <span className="mono" style={{ wordBreak: "break-all", fontSize: 12 }}>{info.redirectUri}</span>
            </div>
            <Hint>Only approve a connection you started yourself, just now. If someone sent you a link to this page, deny it. You decide what the client can do below; it cannot ask for more later, and you can disconnect it under Settings, MCP.</Hint>
            <Field label="Access">
              <AppSelect value={access} onValueChange={setAccess} options={ACCESS_OPTIONS} />
            </Field>
            {(access === "write" || logs) && (
              <Field label="Projects">
                <AppSelect
                  value={group}
                  onValueChange={setGroup}
                  options={[{ value: ALL_PROJECTS, label: "All projects" }, ...info.groups.map((name) => ({ value: name, label: `Group: ${name}` }))]}
                />
              </Field>
            )}
            <CheckRow
              control={<Switch checked={logs} onCheckedChange={setLogs} />}
              title="Allow reading container logs"
              hint="Adds one tool that returns a project's recent logs. An app can print sensitive data into its logs."
            />
            {!info.local && (
              <CheckRow
                control={<Switch checked={recognised} onCheckedChange={setRecognised} />}
                title={<>I recognise <span className="mono">{info.redirectHost}</span> and started this connection</>}
              />
            )}
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={busy !== null || (!info.local && !recognised)} onClick={() => void answer("approve")}>
                {busy === "approve" && <Loader size={13} className="spin" />}Approve
              </Button>
              <Button type="button" variant="outline" disabled={busy !== null} onClick={() => void answer("deny")}>Deny</Button>
            </div>
          </Stack>
        )}
      </div>
    </main>
  );
}
