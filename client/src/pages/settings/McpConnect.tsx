import { useState } from "react";
import { Copy, Plug } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Stack } from "../../components/ui/stack";
import { Hint, Prose } from "../../components/ui/text";
import { copyText } from "../../components/ApiTokenRow";
import mcp from "./McpSection.module.scss";

type Client = "claude" | "codex";
type Level = "local" | "project" | "user";
type Auth = "oauth" | "token";

const CLIENTS: { value: Client; label: string }[] = [
  { value: "claude", label: "Claude Code" },
  { value: "codex", label: "Codex" },
];

const LEVELS: Record<Client, { value: Level; label: string; where: string }[]> = {
  claude: [
    { value: "local", label: "This project, just me", where: "Stored in your Claude Code settings for the current project. Not shared." },
    { value: "project", label: "This project, shared", where: "Written to .mcp.json in the project, so the team gets the same server. Each person signs in on their own, and a token never goes in that file." },
    { value: "user", label: "All my projects", where: "Stored in your Claude Code settings and available in every project." },
  ],
  codex: [
    { value: "user", label: "All my projects", where: "Stored in ~/.codex/config.toml." },
    { value: "project", label: "This project", where: "Stored in .codex/config.toml inside the project. Codex reads it only for a project you have marked as trusted." },
  ],
};

const SERVER = "stackport";

/** The command or file contents that adds the server for one client at one level. A token is read from an environment variable, never written out. */
export function connectSnippet(client: Client, level: Level, auth: Auth, endpoint: string): { text: string; steps: string } {
  if (client === "claude") {
    const scope = level === "local" ? "" : ` --scope ${level}`;
    if (auth === "oauth") {
      return {
        text: `claude mcp add --transport http${scope} ${SERVER} ${endpoint}`,
        steps: "Then run /mcp inside Claude Code, choose stackport and Authenticate. Your browser opens the approval page.",
      };
    }
    return {
      text: `claude mcp add --transport http${scope} ${SERVER} ${endpoint} --header "Authorization: Bearer $STACKPORT_TOKEN"`,
      steps: "Create a token below and export it as STACKPORT_TOKEN first. Claude Code expands the variable when it starts, so the token stays out of any file you share.",
    };
  }
  if (auth === "oauth") {
    return level === "user"
      ? { text: `codex mcp add ${SERVER} --url ${endpoint}\ncodex mcp login ${SERVER}`, steps: "The second command opens your browser to approve the connection." }
      : { text: `# .codex/config.toml\n[mcp_servers.${SERVER}]\nurl = "${endpoint}"`, steps: `Then run codex mcp login ${SERVER} from the project and approve in your browser.` };
  }
  return {
    text: `${level === "user" ? "# ~/.codex/config.toml" : "# .codex/config.toml"}\n[mcp_servers.${SERVER}]\nurl = "${endpoint}"\nbearer_token_env_var = "STACKPORT_TOKEN"`,
    steps: "Create a token below and export it as STACKPORT_TOKEN before starting Codex.",
  };
}

function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (value: T) => void }) {
  return (
    <div className={mcp.filters} role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" className={mcp.filter} aria-pressed={value === option.value} onClick={() => onChange(option.value)}>{option.label}</button>
      ))}
    </div>
  );
}

/** How to add this server to Claude Code and Codex, at each level they support. */
export function McpConnect({ endpoint }: { endpoint: string }) {
  const [client, setClient] = useState<Client>("claude");
  const [level, setLevel] = useState<Level>("local");
  const [auth, setAuth] = useState<Auth>("oauth");

  const levels = LEVELS[client];
  const activeLevel = levels.find((option) => option.value === level) ?? levels[0]!;
  const snippet = connectSnippet(client, activeLevel.value, auth, endpoint);
  const insecure = auth === "oauth" && endpoint.startsWith("http://") && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(endpoint);

  function pickClient(next: Client) {
    setClient(next);
    if (!LEVELS[next].some((option) => option.value === level)) setLevel(LEVELS[next][0]!.value);
  }

  return (
    <div className="card mb-0!">
      <div className="card-title"><Plug size={13} />Connect a client</div>
      <Stack gap={4}>
        <Prose>Add <span className="mono">{endpoint}</span> to a coding agent. Signing in with OAuth needs no token: the client opens an approval page here and you choose what it may do.</Prose>
        <Choice label="Client" value={client} options={CLIENTS} onChange={pickClient} />
        <Choice label="Where to add it" value={activeLevel.value} options={levels.map(({ value, label }) => ({ value, label }))} onChange={setLevel} />
        <Choice label="Sign in with" value={auth} options={[{ value: "oauth", label: "OAuth (browser)" }, { value: "token", label: "API token" }]} onChange={setAuth} />
        <Hint>{activeLevel.where}</Hint>
        <pre className="mono" style={{ margin: 0, padding: 12, overflowX: "auto", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{snippet.text}</pre>
        <Hint>{snippet.steps}</Hint>
        {insecure && <Hint>OAuth needs Stackport to be reached over HTTPS. Use an API token until the admin hostname has a certificate.</Hint>}
        <div>
          <Button type="button" variant="outline" size="sm" onClick={() => void copyText(snippet.text, "Command")}><Copy size={13} />Copy</Button>
        </div>
      </Stack>
    </div>
  );
}
