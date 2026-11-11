import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNginxContent, periodKeyOf } from "../src/modules/observability/routes/metrics";

function line(method: string, requestPath: string): string {
  const when = new Date().toUTCString();
  const d = new Date();
  const mon = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getUTCMonth()];
  const stamp = `${String(d.getUTCDate()).padStart(2, "0")}/${mon}/${d.getUTCFullYear()}:${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:00 +0000`;
  void when;
  return `203.0.113.9 - - [${stamp}] "${method} ${requestPath} HTTP/1.1" 200 10 "-" "curl/8"`;
}

test("request methods and paths taken from the log are counted as data, whatever they are called", () => {
  const log = [line("GET", "/"), line("constructor", "toString"), line("__proto__", "__proto__"), line("GET", "/")].join("\n");
  const result = parseNginxContent(log, false, 24, new Set(), false);
  assert.equal(result.methodCounts["GET"], 2);
  assert.equal(result.methodCounts["constructor"], 1);
  assert.equal(result.methodCounts["__proto__"], 1);
  assert.deepEqual(result.topPaths.map((p) => [p.path, p.count]).sort(), [["/", 2], ["__proto__", 1], ["toString", 1]]);
  assert.equal(typeof result.methodCounts["constructor"], "number");
});

test("only the real periods are accepted, not names every object inherits", () => {
  assert.equal(periodKeyOf("7d"), "7d");
  assert.equal(periodKeyOf("30d"), "30d");
  for (const bad of ["constructor", "__proto__", "toString", "1y", undefined, ["7d"]]) assert.equal(periodKeyOf(bad), "24h");
});
