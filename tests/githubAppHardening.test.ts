import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "net";
import type { Server } from "http";
import Database from "better-sqlite3";
import { config } from "../src/config/env";
import { getDatabase, initializeDatabase } from "../src/config/database";
import { MIGRATIONS, runMigrations, schemaVersion } from "../src/migrations";
import { createKeyring } from "../src/shared/crypto";
import { issueAuthToken } from "../src/modules/identity/sessions";
import { runReencryption, SECRET_COLUMNS, type ReencryptDeps } from "../src/modules/maintenance/migrations/reencryptSecrets";
import { GithubClient, setDefaultGithubClientForTests } from "../src/modules/github/client";
import {
  appJwt, completeLink, completeManifest, forgetInstallationTokens, installationToken, refreshRepositories, rotateAppCredentials, startLink, startManifest, type PreflightDeps,
} from "../src/modules/github/app";
import { getAppSecrets } from "../src/modules/github/store";
import { receiveAppDelivery } from "../src/modules/github/webhook";
import { startFakeGithub, type FakeGithubWithCodes } from "./helpers/fakeGithub";
import app from "../src/app";

let fake: FakeGithubWithCodes;
let client: GithubClient;
let server: Server;
let base: string;
let adminToken: string;
const domain: PreflightDeps = { appConfig: () => ({ enabled: true, domain: "sp.example.com", useSsl: true }), hasCertificate: async () => true };

const pemOf = (): { publicKey: string; privateKey: string } =>
  crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });

before(async () => {
  initializeDatabase();
  fake = (await startFakeGithub()) as FakeGithubWithCodes;
  client = new GithubClient({ apiUrl: fake.apiUrl, webUrl: fake.webUrl, sleep: async () => undefined });
  setDefaultGithubClientForTests(client);
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  adminToken = issueAuthToken("admin");
});
after(async () => { setDefaultGithubClientForTests(null); server.close(); await fake.close(); });

async function registerApp(): Promise<void> {
  const db = getDatabase();
  for (const table of ["github_app", "github_app_installations", "github_app_repositories", "github_app_deliveries", "github_app_states"]) db.prepare(`DELETE FROM ${table}`).run();
  forgetInstallationTokens();
  const start = await startManifest("admin", { modules: [], owner: "", isPublic: false }, domain, client);
  await completeManifest(fake.issueCode("manifest"), start.state, domain, client);
}

const put = (path: string, body: unknown, auth = true): Promise<Response> =>
  fetch(`${base}/api${path}`, { method: "PUT", headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${adminToken}` } : {}) }, body: JSON.stringify(body) });

// ---- rotating the App's own credentials

test("a new private key is proved against GitHub before it replaces the old one", async () => {
  await registerApp();
  const oldKey = getAppSecrets()!.privateKey;
  const fresh = pemOf();

  await assert.rejects(rotateAppCredentials({ privateKey: fresh.privateKey }, client), /did not accept that key/, "GitHub does not know the new key yet");
  assert.equal(getAppSecrets()!.privateKey, oldKey, "a wrong key changes nothing");

  fake.extraPublicKeys.push(fresh.publicKey);
  assert.deepEqual(await rotateAppCredentials({ privateKey: fresh.privateKey }, client), { privateKey: true, webhookSecret: false });
  assert.equal(getAppSecrets()!.privateKey, fresh.privateKey.trim());
  const token = appJwt();
  const [h, p, s] = token.split(".");
  assert.ok(crypto.createVerify("RSA-SHA256").update(`${h}.${p}`).verify(fresh.publicKey, Buffer.from(s, "base64url")), "the App now signs with the new key");
  assert.equal(getAppSecrets()!.webhookSecret, fake.webhookSecret, "the webhook secret was left alone");
});

test("a pasted value that is not a private key, or a key for a different App, is refused", async () => {
  await registerApp();
  await assert.rejects(rotateAppCredentials({ privateKey: "not a key" }, client), /not a PEM private key/);
  await assert.rejects(rotateAppCredentials({ privateKey: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----" }, client), /could not be read/);
  await assert.rejects(rotateAppCredentials({}, client), /Nothing to rotate/);
  await assert.rejects(rotateAppCredentials({ webhookSecret: "short" }, client), /16 to 200/);
});

test("a rotated webhook secret takes effect at once: the old one stops verifying", async () => {
  await registerApp();
  const body = Buffer.from(JSON.stringify({ zen: "x" }));
  const sign = (secret: string): string => "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
  const id = (n: number): string => `11111111-2222-4333-8444-${String(n).padStart(12, "0")}`;
  assert.equal(receiveAppDelivery(body, { signature: sign(fake.webhookSecret), deliveryId: id(1), event: "ping" }).result.status, 202);
  await rotateAppCredentials({ webhookSecret: "a-brand-new-webhook-secret" }, client);
  assert.equal(receiveAppDelivery(body, { signature: sign(fake.webhookSecret), deliveryId: id(2), event: "ping" }).result.status, 401);
  assert.equal(receiveAppDelivery(body, { signature: sign("a-brand-new-webhook-secret"), deliveryId: id(3), event: "ping" }).result.status, 202);
});

test("rotation needs a login, and never returns a secret", async () => {
  await registerApp();
  assert.equal((await put("/github-app/credentials", { webhookSecret: "x".repeat(20) }, false)).status, 401);
  const res = await put("/github-app/credentials", { webhookSecret: "y".repeat(24) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { privateKey: false, webhookSecret: true });
});

// ---- rotating the encryption key

test("rotating ENCRYPTION_KEY re-encrypts the App's secrets and they still work", async () => {
  await registerApp();
  const secrets = getAppSecrets()!;
  const jwt = { jwtSecret: "jwt-for-rotation-test" };
  const oldRing = createKeyring({ ...jwt, encryptionKey: "key-one" });
  const newRing = createKeyring({ ...jwt, encryptionKey: "key-two", previousKeys: ["key-one"] });
  const db = getDatabase();
  db.prepare("UPDATE github_app SET private_key_enc = ?, webhook_secret_enc = ?, client_secret_enc = ? WHERE id = 1")
    .run(oldRing.encrypt(secrets.privateKey), oldRing.encrypt(secrets.webhookSecret), oldRing.encrypt(secrets.clientSecret));

  const columns = SECRET_COLUMNS.filter((c) => c.table === "github_app");
  assert.deepEqual(columns.map((c) => c.column).sort(), ["client_secret_enc", "private_key_enc", "webhook_secret_enc"], "all three are on the re-encryption list");
  const deps: ReencryptDeps = {
    columns,
    rows: (column) => db.prepare(`SELECT ${column.idColumn} AS id, ${column.column} AS value FROM ${column.table} WHERE ${column.column} IS NOT NULL`).all() as { id: number; value: string }[],
    save: (column, id, value) => { db.prepare(`UPDATE ${column.table} SET ${column.column} = ? WHERE ${column.idColumn} = ?`).run(value, id); },
    atomic: (work) => db.transaction(work).immediate(),
    currentKeyId: newRing.currentKeyId, keyIdOf: newRing.keyIdOf, decrypt: newRing.decrypt, encrypt: newRing.encrypt,
  };
  const report = runReencryption("execute", deps);
  assert.match(report.summary, /3|re-encrypted/i);

  const row = db.prepare("SELECT private_key_enc, webhook_secret_enc, client_secret_enc FROM github_app").get() as Record<string, string>;
  for (const value of Object.values(row)) assert.equal(newRing.keyIdOf(value), newRing.currentKeyId, "now under the new key");
  assert.equal(newRing.decrypt(row.webhook_secret_enc), secrets.webhookSecret);
  assert.equal(newRing.decrypt(row.client_secret_enc), secrets.clientSecret);
  const pem = newRing.decrypt(row.private_key_enc);
  assert.equal(pem, secrets.privateKey);
  const [h, p, s] = ((): string[] => { const crypt = crypto.createSign("RSA-SHA256"); const unsigned = "a.b"; return [unsigned.split(".")[0], unsigned.split(".")[1], crypt.update(unsigned).sign(pem).toString("base64url")]; })();
  assert.ok(crypto.createVerify("RSA-SHA256").update(`${h}.${p}`).verify(fake.publicKey, Buffer.from(s, "base64url")), "the decrypted key still signs for this App");
  // The ciphertext is restored to what the running process's own keyring writes, so the rest of the suite is unaffected.
  db.prepare("UPDATE github_app SET private_key_enc = ?, webhook_secret_enc = ?, client_secret_enc = ? WHERE id = 1")
    .run(...[secrets.privateKey, secrets.webhookSecret, secrets.clientSecret].map((v) => createKeyring({ jwtSecret: config.jwtSecret, encryptionKey: config.encryptionKey, previousKeys: config.encryptionKeysPrevious }).encrypt(v)));
});

// ---- no secret reaches an API response, a log, the audit log or the delivery history

test("no secret appears in an API response, the database tables a person can read, the logs or the audit log", async () => {
  await registerApp();
  fake.installations = [{ id: 910, account: { id: 91, login: "leaky", type: "Organization" }, repositories: [{ id: 9101, full_name: "leaky/app", default_branch: "main" }] }];
  const linkState = new URL(startLink("admin", client).authorizeUrl).searchParams.get("state")!;
  await completeLink(fake.issueCode("oauth"), linkState, client);
  await refreshRepositories(910, client);
  const installation = await installationToken(910, client);
  const secrets = getAppSecrets()!;
  const userTokens = [...fake.grantedUserTokens];

  // A delivery whose payload carries things that must never be kept.
  const body = JSON.stringify({ action: "created", installation: { id: 910, account: { id: 91, login: "leaky", type: "Organization" }, access_tokens_url: "https://x", token: "ghs_PAYLOAD_TOKEN_VALUE" }, sender: { login: "x", password: "PAYLOAD_PASSWORD_VALUE" } });
  receiveAppDelivery(Buffer.from(body), { signature: "sha256=" + crypto.createHmac("sha256", secrets.webhookSecret).update(body).digest("hex"), deliveryId: "99999999-aaaa-4bbb-8ccc-dddddddddddd", event: "installation" });
  // And a failed attempt with a bad signature and a failed rotation, which are logged.
  receiveAppDelivery(Buffer.from(body), { signature: "sha256=00", deliveryId: "88888888-aaaa-4bbb-8ccc-dddddddddddd", event: "installation" });
  await rotateAppCredentials({ privateKey: "ghp_NOT_A_KEY_BUT_SECRET_LOOKING" }, client).catch(() => undefined);

  const needles = [
    ...new Set([
      secrets.webhookSecret, secrets.clientSecret, installation, ...userTokens, "ghs_PAYLOAD_TOKEN_VALUE", "PAYLOAD_PASSWORD_VALUE", "ghp_NOT_A_KEY_BUT_SECRET_LOOKING",
      // Body lines of the PEM: enough to identify the key without being its header.
      ...secrets.privateKey.split("\n").filter((line) => line.length > 40).slice(0, 3),
    ]),
  ];

  const sources: Record<string, string> = {};
  for (const route of ["/github-app", "/github-app/repositories", "/github-app/deliveries", "/projects"]) {
    sources[`GET ${route}`] = await (await fetch(`${base}/api${route}`, { headers: { Authorization: `Bearer ${adminToken}` } })).text();
  }
  sources["installations"] = JSON.stringify(getDatabase().prepare("SELECT * FROM github_app_installations").all());
  sources["repositories"] = JSON.stringify(getDatabase().prepare("SELECT * FROM github_app_repositories").all());
  sources["deliveries"] = JSON.stringify(getDatabase().prepare("SELECT * FROM github_app_deliveries").all());
  sources["states"] = JSON.stringify(getDatabase().prepare("SELECT * FROM github_app_states").all());
  sources["github_app (public columns)"] = JSON.stringify(getDatabase().prepare("SELECT app_id, slug, name, client_id, owner_login, html_url, registered_origin, modules_json FROM github_app").all());
  await new Promise((resolve) => setTimeout(resolve, 600)); // pino writes to its file asynchronously
  for (const file of ["app.log", "audit.log"]) {
    const full = path.join(config.logDir, file);
    sources[file] = fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "";
  }

  for (const [where, text] of Object.entries(sources)) {
    for (const needle of needles) assert.ok(!text.includes(needle), `${where} contains a secret (${needle.slice(0, 12)}...)`);
  }
  assert.ok(sources["app.log"].length > 0 || sources["audit.log"].length > 0, "the logs were actually read");
  assert.match(sources["GET /github-app"], /leaky/, "and the responses are not empty");
});

test("the stored secrets are ciphertext, and the installation token is held in memory only", async () => {
  await registerApp();
  fake.installations = [{ id: 920, account: { id: 92, login: "mem", type: "User" }, repositories: [] }];
  await completeLink(fake.issueCode("oauth"), new URL(startLink("admin", client).authorizeUrl).searchParams.get("state")!, client);
  const token = await installationToken(920, client);
  const everything = ["github_app", "github_app_installations", "github_app_repositories", "github_app_deliveries", "github_app_states"]
    .map((table) => JSON.stringify(getDatabase().prepare(`SELECT * FROM ${table}`).all())).join("\n");
  assert.ok(!everything.includes(token), "the installation token is not in the database");
  assert.ok(!everything.includes("BEGIN"), "no PEM is stored in clear");
});

// ---- bounds

test("a webhook body over the limit is refused before it is read in full, and nothing is stored", async () => {
  await registerApp();
  const before = (getDatabase().prepare("SELECT COUNT(*) AS n FROM github_app_deliveries").get() as { n: number }).n;
  const res = await fetch(`${base}/api/hooks/github/app`, { method: "POST", headers: { "content-type": "application/json", "x-github-delivery": "77777777-aaaa-4bbb-8ccc-dddddddddddd", "x-github-event": "push", "x-hub-signature-256": "sha256=00" }, body: "x".repeat(6 * 1024 * 1024) });
  assert.equal(res.status, 413);
  assert.equal((getDatabase().prepare("SELECT COUNT(*) AS n FROM github_app_deliveries").get() as { n: number }).n, before);
});

// ---- upgrade and rollback

/** A database at schema version 15, built the way the existing migration tests do: from the initialised schema, with the
 *  App's tables and columns taken away again. */
function legacyDb(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stackport-ghapp-migration-"));
  const file = path.join(dir, "legacy.sqlite");
  fs.writeFileSync(file, getDatabase().serialize());
  const db = new Database(file);
  db.exec(`DROP TABLE github_app; DROP TABLE github_app_installations; DROP TABLE github_app_repositories; DROP TABLE github_app_deliveries; DROP TABLE github_app_states;
           ALTER TABLE projects DROP COLUMN github_auth_mode; ALTER TABLE projects DROP COLUMN github_repository_id; ALTER TABLE projects DROP COLUMN github_installation_id;`);
  db.pragma("user_version = 15");
  return db;
}

test("upgrade: a database from before the App keeps every project, and the new tables and columns appear empty", () => {
  const db = legacyDb();
  try {
    db.prepare("INSERT INTO projects (name, source_type, github_repo) VALUES ('existing', 'github', 'acme/shop')").run();
    runMigrations(db);
    runMigrations(db); // and again: idempotent
    assert.equal(schemaVersion(db), Math.max(...MIGRATIONS.map((m) => m.id)));
    const project = db.prepare("SELECT name, github_repo, github_auth_mode, github_repository_id, github_installation_id FROM projects WHERE name = 'existing'").get() as Record<string, unknown>;
    assert.deepEqual(project, { name: "existing", github_repo: "acme/shop", github_auth_mode: null, github_repository_id: null, github_installation_id: null });
    for (const table of ["github_app", "github_app_installations", "github_app_repositories", "github_app_deliveries", "github_app_states"]) {
      assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 0, table);
    }
  } finally { db.close(); }
});

test("rollback: the previous release's code runs on the migrated database, as it only ever added", () => {
  const db = legacyDb();
  try {
    runMigrations(db);
    const latest = schemaVersion(db);
    runMigrations(db, MIGRATIONS.filter((m) => m.id <= 15)); // the older release starts: it leaves a newer database alone
    assert.equal(schemaVersion(db), latest);
    // What the older release does with projects, using only the columns it knows.
    db.prepare("INSERT INTO projects (name, source_type, github_repo) VALUES ('made-by-old-code', 'github', 'acme/old')").run();
    db.prepare("UPDATE projects SET auto_deploy_branch = 'main' WHERE name = 'made-by-old-code'").run();
    const row = db.prepare("SELECT name, auto_deploy_branch, github_auth_mode FROM projects WHERE name = 'made-by-old-code'").get() as Record<string, unknown>;
    assert.deepEqual(row, { name: "made-by-old-code", auto_deploy_branch: "main", github_auth_mode: null });
  } finally { db.close(); }
});
