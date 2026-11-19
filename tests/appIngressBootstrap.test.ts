import { after, afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { closeDatabase, getDatabase, initializeDatabase } from "../src/config/database";
import { config } from "../src/config/env";
import { appIngressDeps, ensureAppIngress } from "../src/modules/ingress/bootstrap";
import { getNginxAppConfig, setNginxAppConfig } from "../src/modules/ingress/nginx/appConfig";

const realDeps = { ...appIngressDeps };
const originalDomain = config.stackportDomain;
let events: string[];
let certificate: boolean;

beforeEach(() => {
  initializeDatabase();
  getDatabase().exec("DELETE FROM projects; DELETE FROM app_meta WHERE key LIKE 'nginx_app_%'");
  // A saved hostname must take priority over the installer's original environment.
  Object.assign(config, { stackportDomain: "installer.example.com" });
  events = [];
  certificate = false;
  appIngressDeps.nginxReady = async () => true;
  appIngressDeps.sleep = async () => undefined;
  appIngressDeps.apply = async () => {
    events.push(`apply:${certificate ? "https" : "http"}`);
    return { ok: true, output: "nginx config applied" };
  };
  appIngressDeps.hasCertificate = async (domain) => {
    events.push(`check:${domain}`);
    return certificate;
  };
  appIngressDeps.issue = async (domain) => {
    events.push(`issue:${domain}`);
    certificate = true;
    return { ok: true, output: "certificate issued" };
  };
  appIngressDeps.selfSigned = async () => {
    events.push("self-signed");
    return { ok: true, output: "self-signed certificate ready" };
  };
});

afterEach(() => {
  Object.assign(appIngressDeps, realDeps);
  Object.assign(config, { stackportDomain: originalDomain });
});
after(() => closeDatabase());

test("startup repairs a saved HTTPS hostname with a missing certificate, then reapplies nginx", async () => {
  const saved = setNginxAppConfig({ enabled: true, domain: "sp.example.com", useSsl: true });
  await ensureAppIngress();
  assert.deepEqual(events, ["apply:http", "check:sp.example.com", "issue:sp.example.com", "apply:https"]);
  assert.deepEqual(getNginxAppConfig(), saved, "use the saved hostname and retain the requested HTTPS setting");
  assert.equal(getDatabase().prepare("SELECT 1 FROM app_meta WHERE key = 'nginx_app_bootstrap_pending'").get(), undefined);
});

test("startup with an existing certificate applies nginx without requesting another certificate", async () => {
  setNginxAppConfig({ enabled: true, domain: "sp.example.com", useSsl: true });
  certificate = true;
  await ensureAppIngress();
  assert.deepEqual(events, ["apply:https", "check:sp.example.com"]);
});

for (const settings of [{ enabled: true, useSsl: false }, { enabled: false, useSsl: true }]) {
  test(`startup preserves ${settings.enabled ? "an explicit HTTP choice" : "disabled hostname publishing"}`, async () => {
    const saved = setNginxAppConfig({ ...settings, domain: "sp.example.com" });
    await ensureAppIngress();
    assert.deepEqual(events, ["apply:http"]);
    assert.deepEqual(getNginxAppConfig(), saved);
  });
}

test("a failed HTTP apply does not attempt certificate issuance", async () => {
  const saved = setNginxAppConfig({ enabled: true, domain: "sp.example.com", useSsl: true });
  appIngressDeps.apply = async () => { events.push("apply:failed"); return { ok: false, output: "nginx config refused" }; };
  await ensureAppIngress();
  assert.deepEqual(events, ["apply:failed"]);
  assert.deepEqual(getNginxAppConfig(), saved);
});

for (const throws of [false, true]) {
  test(`certificate ${throws ? "exception" : "failure"} leaves HTTP available and is retried on the next startup`, async () => {
    const saved = setNginxAppConfig({ enabled: true, domain: "sp.example.com", useSsl: true });
    appIngressDeps.issue = async (domain) => {
      events.push(`issue:failed:${domain}`);
      if (throws) throw new Error("certificate request failed");
      return { ok: false, output: "certificate request failed" };
    };
    await ensureAppIngress();
    assert.deepEqual(events, ["apply:http", "check:sp.example.com", "issue:failed:sp.example.com"]);
    assert.deepEqual(getNginxAppConfig(), saved);

    events = [];
    appIngressDeps.issue = async (domain) => {
      events.push(`issue:${domain}`);
      certificate = true;
      return { ok: true, output: "certificate issued" };
    };
    await ensureAppIngress();
    assert.deepEqual(events, ["apply:http", "check:sp.example.com", "issue:sp.example.com", "apply:https"]);
  });
}

test("a fresh installation still bootstraps the configured domain", async () => {
  await ensureAppIngress();
  assert.deepEqual(events, ["apply:http", "issue:installer.example.com", "apply:https"]);
  assert.equal(getNginxAppConfig().domain, "installer.example.com");
  assert.equal(getNginxAppConfig().useSsl, true);
});

test("a failed HTTPS reload is repaired on the next startup without issuing the certificate again", async () => {
  const saved = setNginxAppConfig({ enabled: true, domain: "sp.example.com", useSsl: true });
  let applies = 0;
  appIngressDeps.apply = async () => {
    applies++;
    events.push(applies === 1 ? "apply:http" : "apply:failed");
    return { ok: applies === 1, output: applies === 1 ? "HTTP ready" : "nginx reload failed" };
  };
  await ensureAppIngress();
  assert.deepEqual(events, ["apply:http", "check:sp.example.com", "issue:sp.example.com", "apply:failed"]);
  assert.deepEqual(getNginxAppConfig(), saved);

  events = [];
  appIngressDeps.apply = async () => { events.push("apply:https"); return { ok: true, output: "HTTPS ready" }; };
  await ensureAppIngress();
  assert.deepEqual(events, ["apply:https", "check:sp.example.com"]);
});

test("a domainless installation still uses its bootstrap certificate", async () => {
  Object.assign(config, { stackportDomain: "" });
  await ensureAppIngress();
  assert.deepEqual(events, ["self-signed", "apply:http"]);
});
