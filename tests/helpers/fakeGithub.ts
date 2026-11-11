import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";

/** An in-process stand-in for GitHub: the manifest conversion, the OAuth token exchange, the App's installations,
 *  installation tokens and the repositories an installation exposes. It checks what real GitHub checks that matters
 *  to us (a JWT signed with the App's key, a code used once, a token for the right installation) so a bug in how we
 *  call it fails here. */

export interface FakeInstallation {
  id: number;
  appId?: number;
  account: { id: number; login: string; type: string };
  permissions?: Record<string, string>;
  suspended?: boolean;
  repositories: { id: number; full_name: string; default_branch?: string; private?: boolean; archived?: boolean }[];
  /** Branches, and files, per repository full name, for the endpoints the wizard reads. */
  branches?: Record<string, string[]>;
  files?: Record<string, Record<string, string>>;
}

export interface FakeGithub {
  apiUrl: string;
  webUrl: string;
  appId: number;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  publicKey: string;
  installations: FakeInstallation[];
  /** Requests received, as `METHOD path`. */
  requests: string[];
  /** The next N requests to this path prefix answer 429 with `Retry-After: 1`. */
  rateLimit: { prefix: string; remaining: number } | null;
  tokenLifetimeMs: number;
  maxConcurrent: number;
  holdMs: number;
  conversions: number;
  tokensIssued: number;
  grantedUserTokens: Set<string>;
  close(): Promise<void>;
}

export async function startFakeGithub(): Promise<FakeGithub> {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const fake: FakeGithub = {
    apiUrl: "", webUrl: "", appId: 4242, clientId: "Iv1.fakeclient", clientSecret: "fake-client-secret", webhookSecret: "fake-webhook-secret", publicKey,
    installations: [], requests: [], rateLimit: null, tokenLifetimeMs: 60 * 60 * 1000, maxConcurrent: 0, holdMs: 0, conversions: 0, tokensIssued: 0,
    grantedUserTokens: new Set(), close: async () => undefined,
  };
  const usedCodes = new Set<string>();
  const codes = new Map<string, "manifest" | "oauth">();
  const installationTokens = new Map<string, { installationId: number; expiresAt: number }>();
  let inFlight = 0;

  const verifyJwt = (token: string): boolean => {
    const [h, p, s] = token.split(".");
    if (!h || !p || !s) return false;
    if (!crypto.createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(s, "base64url"))) return false;
    const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as { iat: number; exp: number; iss: string };
    const now = Math.floor(Date.now() / 1000);
    return claims.iss === String(fake.appId) && claims.exp - claims.iat <= 600 && claims.exp > now - 5;
  };

  const server = http.createServer((req, res) => {
    inFlight += 1;
    fake.maxConcurrent = Math.max(fake.maxConcurrent, inFlight);
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      setTimeout(() => {
        try { respond(req, Buffer.concat(chunks).toString("utf8"), res); }
        finally { inFlight -= 1; }
      }, fake.holdMs);
    });
  });

  const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };

  function respond(req: http.IncomingMessage, body: string, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://x");
    const key = `${req.method} ${url.pathname}`;
    fake.requests.push(key);
    const auth = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (fake.rateLimit && url.pathname.startsWith(fake.rateLimit.prefix) && fake.rateLimit.remaining > 0) {
      fake.rateLimit.remaining -= 1;
      return json(res, 429, { message: "slow down" }, { "retry-after": "1" });
    }

    const conversion = /^\/app-manifests\/([^/]+)\/conversions$/.exec(url.pathname);
    if (req.method === "POST" && conversion) {
      const code = conversion[1];
      if (codes.get(code) !== "manifest" || usedCodes.has(code)) return json(res, 404, { message: "Not Found" });
      usedCodes.add(code);
      fake.conversions += 1;
      return json(res, 201, {
        id: fake.appId, slug: "stackport-test", name: "Stackport test", client_id: fake.clientId, client_secret: fake.clientSecret,
        webhook_secret: fake.webhookSecret, pem: privateKey, html_url: "https://github.test/apps/stackport-test",
        owner: { login: "acme", type: "Organization" },
        permissions: { contents: "read", metadata: "read", deployments: "write", checks: "read", actions: "read", statuses: "read" },
        events: ["push", "installation", "installation_repositories", "workflow_run", "check_suite", "release"],
      });
    }

    if (req.method === "POST" && url.pathname === "/login/oauth/access_token") {
      const form = new URLSearchParams(body);
      const code = form.get("code") ?? "";
      if (form.get("client_id") !== fake.clientId || form.get("client_secret") !== fake.clientSecret || codes.get(code) !== "oauth" || usedCodes.has(code)) return json(res, 200, { error: "bad_verification_code" });
      usedCodes.add(code);
      const token = `ghu_${crypto.randomBytes(8).toString("hex")}`;
      fake.grantedUserTokens.add(token);
      return json(res, 200, { access_token: token });
    }

    if (req.method === "GET" && url.pathname === "/user/installations") {
      if (!fake.grantedUserTokens.has(auth)) return json(res, 401, { message: "Bad credentials" });
      const page = Number(url.searchParams.get("page") ?? "1");
      const all = fake.installations.map((i) => ({ id: i.id, app_id: i.appId ?? fake.appId, account: i.account, permissions: i.permissions ?? { contents: "read" }, suspended_at: i.suspended ? "2026-01-01T00:00:00Z" : null }));
      return json(res, 200, { total_count: all.length, installations: all.slice((page - 1) * 100, page * 100) });
    }

    if (req.method === "GET" && url.pathname === "/app/installations") {
      if (!verifyJwt(auth)) return json(res, 401, { message: "A JSON web token could not be decoded" });
      const page = Number(url.searchParams.get("page") ?? "1");
      const all = fake.installations.filter((i) => (i.appId ?? fake.appId) === fake.appId).map((i) => ({ id: i.id, app_id: fake.appId, account: i.account, permissions: i.permissions ?? { contents: "read" }, suspended_at: i.suspended ? "2026-01-01T00:00:00Z" : null }));
      return json(res, 200, all.slice((page - 1) * 100, page * 100));
    }

    const tokenRoute = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname);
    if (req.method === "POST" && tokenRoute) {
      if (!verifyJwt(auth)) return json(res, 401, { message: "A JSON web token could not be decoded" });
      const installation = fake.installations.find((i) => i.id === Number(tokenRoute[1]));
      if (!installation) return json(res, 404, { message: "Not Found" });
      if (installation.suspended) return json(res, 403, { message: "This GitHub App installation is suspended" });
      const token = `ghs_${crypto.randomBytes(10).toString("hex")}`;
      const expiresAt = Date.now() + fake.tokenLifetimeMs;
      installationTokens.set(token, { installationId: installation.id, expiresAt });
      fake.tokensIssued += 1;
      return json(res, 201, { token, expires_at: new Date(expiresAt).toISOString() });
    }

    if (req.method === "GET" && url.pathname === "/installation/repositories") {
      const granted = installationTokens.get(auth);
      if (!granted || granted.expiresAt < Date.now()) return json(res, 401, { message: "Bad credentials" });
      const installation = fake.installations.find((i) => i.id === granted.installationId)!;
      const page = Number(url.searchParams.get("page") ?? "1");
      return json(res, 200, { total_count: installation.repositories.length, repositories: installation.repositories.slice((page - 1) * 100, page * 100) });
    }
    const repoRoute = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (req.method === "GET" && repoRoute) {
      const granted = installationTokens.get(auth);
      if (!granted || granted.expiresAt < Date.now()) return json(res, 401, { message: "Bad credentials" });
      const installation = fake.installations.find((i) => i.id === granted.installationId)!;
      const fullName = `${repoRoute[1]}/${repoRoute[2]}`;
      if (!installation.repositories.some((r) => r.full_name === fullName)) return json(res, 404, { message: "Not Found" });
      const rest = repoRoute[3] ?? "";
      if (rest === "") return json(res, 200, { full_name: fullName });
      if (rest === "/branches") return json(res, 200, (installation.branches?.[fullName] ?? ["main"]).map((name) => ({ name, commit: { sha: crypto.createHash("sha1").update(name).digest("hex") } })));
      if (rest.startsWith("/git/trees/")) return json(res, 200, { truncated: false, tree: Object.keys(installation.files?.[fullName] ?? {}).map((path) => ({ path, type: "blob" })) });
      if (rest.startsWith("/contents/")) {
        const file = installation.files?.[fullName]?.[decodeURIComponent(rest.slice("/contents/".length))];
        if (file === undefined) return json(res, 404, { message: "Not Found" });
        return json(res, 200, { type: "file", encoding: "base64", content: Buffer.from(file).toString("base64") });
      }
    }
    return json(res, 404, { message: "Not Found" });
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.apiUrl = origin;
  fake.webUrl = origin;
  fake.close = () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  Object.assign(fake, {
    /** A code GitHub would hand back after the admin confirms the manifest or authorizes the user. */
    issueCode: (purpose: "manifest" | "oauth"): string => { const code = crypto.randomBytes(10).toString("hex"); codes.set(code, purpose); return code; },
    /** Installation tokens the fake has issued, so a test can assert one was not reused. */
    tokenCount: (): number => installationTokens.size,
  });
  return fake;
}

export type FakeGithubWithCodes = FakeGithub & { issueCode(purpose: "manifest" | "oauth"): string; tokenCount(): number };
