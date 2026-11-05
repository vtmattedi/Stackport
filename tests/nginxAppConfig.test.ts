import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { initializeDatabase, getDatabase } from "../src/config/database";
import { config } from "../src/config/env";
import { getNginxAppConfig, setNginxAppConfig } from "../src/services/nginx/appConfig";
import { createProject } from "../src/services/projectAdmin";

beforeEach(() => {
  initializeDatabase();
  getDatabase().exec("DELETE FROM projects; DELETE FROM app_meta WHERE key IN ('nginx_app_enabled','nginx_app_domain','nginx_app_use_ssl')");
});

test("app ingress preserves defaults, normalized domains and persisted keys", () => {
  assert.deepEqual(getNginxAppConfig(), { enabled: false, domain: "", port: config.port, useSsl: true });
  assert.deepEqual(setNginxAppConfig({ enabled: true, domain: " APP.EXAMPLE.COM ", useSsl: false }),
    { enabled: true, domain: "app.example.com", port: config.port, useSsl: false });
  assert.deepEqual(getDatabase().prepare("SELECT key,value FROM app_meta WHERE key LIKE 'nginx_app_%' ORDER BY key").all(),
    [{ key: "nginx_app_domain", value: "app.example.com" }, { key: "nginx_app_enabled", value: "1" }, { key: "nginx_app_use_ssl", value: "0" }]);
});

test("app ingress rejects project domain and port conflicts before writing config", () => {
  createProject({ name: "reserved", sourceType: "upload", domain: "reserved.example.com", internalPort: config.port });
  assert.throws(() => setNginxAppConfig({ enabled: true, domain: "reserved.example.com" }), /backend port/);
  getDatabase().prepare("UPDATE projects SET internal_port=NULL").run();
  assert.throws(() => setNginxAppConfig({ enabled: true, domain: "RESERVED.EXAMPLE.COM" }), /already uses/);
  assert.equal(getNginxAppConfig().enabled, false);
});

test("project creation honors the same app domain and port reservations after extraction", () => {
  setNginxAppConfig({ enabled: true, domain: "app.example.com" });
  assert.throws(() => createProject({ name: "domain-conflict", sourceType: "upload", domain: "APP.EXAMPLE.COM" }), /reserved/);
  assert.throws(() => createProject({ name: "port-conflict", sourceType: "upload", internalPort: config.port }), /reserved/);
  assert.equal((getDatabase().prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n, 0);
});
