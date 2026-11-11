import { config } from "../../config/env";

/**
 * Calls to GitHub, with what the plan requires of every one (§7 of docs/1.3.7/github-app.md):
 * a timeout, at most two in flight per instance, and backoff when GitHub says to slow down (403 with a
 * rate-limit message, or 429). The base URLs come from the environment only.
 */

export class GithubError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export interface GithubResponse<T = unknown> { status: number; body: T; headers: Headers }

export interface GithubRequest {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /** Path on the API origin, or a full URL on the web origin (the OAuth endpoints). */
  path: string;
  /** `Bearer` for an App JWT or an installation token; user tokens use `token`. */
  bearer?: string;
  body?: unknown;
  /** Send as a form (the OAuth token exchange), not JSON. */
  form?: Record<string, string>;
  /** The OAuth endpoints live on github.com, not api.github.com. */
  web?: boolean;
}

export interface ClientOptions {
  apiUrl: string;
  webUrl: string;
  timeoutMs?: number;
  /** How many times a rate-limited call is retried, waiting as GitHub asked. */
  retries?: number;
  /** For tests: replaces the real wait. */
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

const MAX_CONCURRENT = 2;
const MAX_WAIT_MS = 60_000;

export class GithubClient {
  private active = 0;
  private waiting: Array<() => void> = [];
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.retries = options.retries ?? 2;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get webUrl(): string { return this.options.webUrl; }
  get apiUrl(): string { return this.options.apiUrl; }

  private async slot<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_CONCURRENT) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    try { return await work(); }
    finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }

  /** How long to wait before retrying, or null when the response is not a rate limit. */
  private backoff(response: Response, attempt: number): number | null {
    const limited = response.status === 429 || (response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")));
    if (!limited) return null;
    const retryAfter = Number(response.headers.get("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, MAX_WAIT_MS);
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    if (Number.isFinite(reset) && reset > 0) return Math.min(Math.max(reset * 1000 - Date.now(), 1000), MAX_WAIT_MS);
    return Math.min(1000 * 2 ** attempt, MAX_WAIT_MS);
  }

  async request<T = unknown>(req: GithubRequest): Promise<GithubResponse<T>> {
    const origin = req.web ? this.options.webUrl : this.options.apiUrl;
    const url = `${origin}${req.path.startsWith("/") ? "" : "/"}${req.path}`;
    const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "stackport", "X-GitHub-Api-Version": "2022-11-28" };
    if (req.bearer) headers["Authorization"] = `Bearer ${req.bearer}`;
    let body: string | undefined;
    if (req.form) { headers["Content-Type"] = "application/x-www-form-urlencoded"; headers["Accept"] = "application/json"; body = new URLSearchParams(req.form).toString(); }
    else if (req.body !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(req.body); }

    return this.slot(async () => {
      for (let attempt = 0; ; attempt++) {
        let response: Response;
        try {
          response = await this.fetchImpl(url, { method: req.method ?? "GET", headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
        } catch (err) {
          throw new GithubError(err instanceof Error && err.name === "TimeoutError" ? "GitHub did not answer in time" : `GitHub could not be reached: ${err instanceof Error ? err.message : String(err)}`, 0);
        }
        const wait = attempt < this.retries ? this.backoff(response, attempt) : null;
        if (wait !== null) { await this.sleep(wait); continue; }
        const text = await response.text();
        let parsed: unknown = null;
        if (text) { try { parsed = JSON.parse(text); } catch { parsed = text; } }
        if (!response.ok) {
          const message = parsed && typeof parsed === "object" && "message" in parsed ? String((parsed as { message: unknown }).message) : `HTTP ${response.status}`;
          throw new GithubError(message, response.status);
        }
        return { status: response.status, body: parsed as T, headers: response.headers };
      }
    });
  }
}

let shared: GithubClient | null = null;

/** The client for the configured GitHub (github.com unless GITHUB_API_URL says otherwise). */
export function defaultGithubClient(): GithubClient {
  shared ??= new GithubClient({ apiUrl: config.githubApiUrl, webUrl: config.githubWebUrl });
  return shared;
}

/** Tests only: replaces the shared client, so the real routes can be exercised against a fake GitHub. */
export function setDefaultGithubClientForTests(client: GithubClient | null): void {
  shared = client;
}
