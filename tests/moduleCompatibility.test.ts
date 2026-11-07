import { test } from "node:test";
import assert from "node:assert/strict";
import routes from "../src/application/http/routes";
import legacyRoutes from "../src/routes";

test("compatibility routes reuse the canonical router instead of registering it again", () => {
  assert.equal(legacyRoutes, routes);
});
