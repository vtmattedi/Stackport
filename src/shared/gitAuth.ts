import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/** How a credential reaches Git. It goes in the child process's environment, never in its arguments:
 *  the arguments of every process are readable by every local user (`ps`, /proc/<pid>/cmdline),
 *  an environment only by its owner and root.
 *
 *  The header is scoped to the repository's own origin (`http.<origin>/.extraHeader`). Unscoped, it
 *  would go to every host Git talks to, such as a submodule that points at someone else's server. */

/** Git reads configuration from GIT_CONFIG_COUNT / _KEY_n / _VALUE_n since 2.31. */
export const MIN_GIT_VERSION: readonly [number, number] = [2, 31];

const PASSTHROUGH = new Set([
  "PATH", "HOME", "USERPROFILE", "LANG", "LC_ALL", "TZ", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "XDG_CONFIG_HOME",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "GIT_SSL_CAINFO", "GIT_SSL_CAPATH",
]);

/** `https://github.com/` for `https://github.com/owner/repo.git`. Null for anything that is not an http(s) URL. */
export function gitUrlScope(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? `${parsed.origin}/` : null;
  } catch {
    return null;
  }
}

/** The `Authorization` header value for HTTP basic credentials. */
export function basicAuthHeader(username: string, secret: string): string {
  return `Authorization: Basic ${Buffer.from(`${username}:${secret}`).toString("base64")}`;
}

/** The environment for a Git process: only what Git needs (Stackport's own secrets are not passed on),
 *  with `header` scoped to `scope` when there is one. Git can never stop to ask for a password. */
export function buildGitEnv(source: NodeJS.ProcessEnv, header: string | null, scope: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: "0" };
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && PASSTHROUGH.has(key)) env[key] = value;
  }
  if (header !== null && scope !== null) {
    env["GIT_CONFIG_COUNT"] = "1";
    env["GIT_CONFIG_KEY_0"] = `http.${scope}.extraHeader`;
    env["GIT_CONFIG_VALUE_0"] = header;
  }
  return env;
}

/** `[2, 53]` for `git version 2.53.0.windows.1`. */
export function parseGitVersion(output: string): [number, number] | null {
  const match = /git version (\d+)\.(\d+)/.exec(output);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

export function gitVersionSupportsEnvConfig(version: readonly [number, number]): boolean {
  return version[0] > MIN_GIT_VERSION[0] || (version[0] === MIN_GIT_VERSION[0] && version[1] >= MIN_GIT_VERSION[1]);
}

let checked: Promise<string | null> | null = null;

/** Null when this machine's Git can take the credential from the environment, else why it cannot.
 *  There is deliberately no fallback to the command line. Checked once per process. */
export function gitCredentialProblem(run: () => Promise<string> = async () => (await execFileAsync("git", ["--version"], { timeout: 10_000 })).stdout): Promise<string | null> {
  checked ??= run().then((output) => {
    const version = parseGitVersion(output);
    if (!version) return "Could not tell which version of Git is installed, so a credential cannot be passed to it safely.";
    return gitVersionSupportsEnvConfig(version)
      ? null
      : `Git ${version[0]}.${version[1]} is too old to take a credential from the environment (needs ${MIN_GIT_VERSION.join(".")} or newer). Stackport does not put credentials on the command line; update Git.`;
  }, () => "Git is not available.");
  return checked;
}

/** For tests. */
export function resetGitCredentialCheck(): void {
  checked = null;
}
