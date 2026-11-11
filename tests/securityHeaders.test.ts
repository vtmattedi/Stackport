import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "net";
import type { Server } from "http";
import app, { securityHeaders } from "../src/app";
import { initializeDatabase } from "../src/config/database";

let server: Server;
let base: string;

before(async () => {
  initializeDatabase();
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); });

const directive = (csp: string, name: string): string[] => (csp.split(";").map((d) => d.trim().split(/\s+/)).find((d) => d[0] === name) ?? []).slice(1);

test("a form may be posted to GitHub (registering the App from a manifest), and nowhere else outside this site", async () => {
  const res = await fetch(`${base}/health`);
  const csp = res.headers.get("content-security-policy") ?? "";
  assert.deepEqual(directive(csp, "form-action"), ["'self'", "https://github.com"]);
  assert.deepEqual(directive(csp, "default-src"), ["'self'"], "the rest of helmet's policy is unchanged");
  assert.deepEqual(directive(csp, "frame-ancestors"), ["'self'"]);
});

test("a GitHub Enterprise address is allowed by its origin, and a setting that is not an address adds nothing", () => {
  const headerFor = async (url: string): Promise<string> => {
    const headers: Record<string, string> = {};
    await new Promise<void>((resolve) => securityHeaders(url)({} as never, { setHeader: (k: string, v: string) => { headers[k.toLowerCase()] = v; }, removeHeader: () => undefined } as never, () => resolve()));
    return headers["content-security-policy"] ?? "";
  };
  return Promise.all([headerFor("https://ghe.example.com/api/v3"), headerFor("not a url")]).then(([ghe, bad]) => {
    assert.deepEqual(directive(ghe, "form-action"), ["'self'", "https://ghe.example.com"]);
    assert.deepEqual(directive(bad, "form-action"), ["'self'"]);
  });
});
