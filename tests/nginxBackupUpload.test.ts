import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { closeDatabase, getDatabase, initializeDatabase } from "../src/config/database";
import { FULL_BACKUP_MAX_UPLOAD_BYTES } from "../src/shared/backupLimits";
import { generateNginxConfig, setNginxAppConfig } from "../src/modules/ingress/nginx/configWriter";
import { rowToProject, type ProjectRow } from "../src/modules/projects/types";

beforeEach(() => {
  initializeDatabase();
  getDatabase().exec("DELETE FROM project_domains; DELETE FROM projects; DELETE FROM app_meta WHERE key LIKE 'nginx_app_%'");
});
after(() => closeDatabase());

test("only Stackport's exact backup upload endpoint accepts large streamed requests", async () => {
  setNginxAppConfig({ enabled: true, domain: "sp.example.com", useSsl: false });
  const db = getDatabase();
  const id = db.prepare("INSERT INTO projects (name, source_type) VALUES ('Application', 'upload')").run().lastInsertRowid;
  db.prepare("INSERT INTO project_domains (project_id, domain, service, container_port) VALUES (?, 'app.example.com', 'stackport', 3000)").run(id);
  const projects = (db.prepare("SELECT * FROM projects").all() as ProjectRow[]).map(rowToProject);
  const rendered = await generateNginxConfig(projects);
  const upload = rendered.match(/location = \/api\/backup\/restore\/upload \{([^}]+)\}/);
  assert.ok(upload);
  assert.match(upload[1], new RegExp(`client_max_body_size ${FULL_BACKUP_MAX_UPLOAD_BYTES};`));
  assert.match(upload[1], /proxy_request_buffering off;/);
  assert.match(upload[1], /proxy_http_version 1\.1;/);
  assert.match(upload[1], /proxy_read_timeout 3600s;/);
  assert.match(upload[1], /proxy_set_header Host \$host;/);
  assert.equal((rendered.match(/client_max_body_size/g) ?? []).length, 1, "project and other API routes retain their normal limits");
  assert.match(rendered, /location = \/api\/backup\/restore\/inspect \{[^}]*proxy_read_timeout 3600s;/, "large archives can be verified without the proxy's default response timeout");
  assert.match(rendered, /http:\/\/sp\d+-stackport:3000/, "a managed service named stackport remains a regular project target");
});

test("without an app route, project routes do not acquire the backup upload override", async () => {
  const rendered = await generateNginxConfig([]);
  assert.doesNotMatch(rendered, /client_max_body_size/);
});
