import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/** The local stdio MCP server starts itself when imported, so its tool list is read from the source. */
const source = fs.readFileSync(path.join(__dirname, "../src/transports/mcp/stdio.ts"), "utf8").replace(/\r\n/g, "\n");

interface ToolInfo { name: string; description: string; readOnly: boolean; destructive: boolean }

function tools(): ToolInfo[] {
  const out: ToolInfo[] = [];
  const starts = [...source.matchAll(/server\.registerTool\(\s*"([^"]+)"/g)];
  starts.forEach((match, i) => {
    const block = source.slice(match.index, starts[i + 1]?.index ?? source.length);
    const description = /description: "((?:[^"\\]|\\.)*)"/.exec(block)?.[1] ?? "";
    const readOnly = /readOnlyHint: (true|false)/.exec(block)?.[1] === "true";
    const destructive = /destructiveHint: (true|false)/.exec(block)?.[1] === "true";
    out.push({ name: match[1], description, readOnly, destructive });
  });
  return out;
}

test("the stdio tools are found", () => {
  assert.ok(tools().length >= 20);
});

test("a stdio tool is marked destructive in its annotation exactly when its description says DESTRUCTIVE", () => {
  for (const tool of tools()) {
    assert.equal(tool.description.startsWith("DESTRUCTIVE"), tool.destructive, `${tool.name}: description and destructiveHint disagree`);
    if (tool.readOnly) assert.equal(tool.destructive, false, `${tool.name}: a read-only tool cannot be destructive`);
  }
});

test("the tools that overwrite data, remove routes or interrupt what is running are the destructive ones", () => {
  const destructive = tools().filter((t) => t.destructive).map((t) => t.name).sort();
  assert.deepEqual(destructive, [
    "stackport_apply_nginx_config", "stackport_delete_project_domain", "stackport_delete_project_env_file",
    "stackport_run_project_action", "stackport_set_project_domain_ssl", "stackport_set_project_env_file",
    "stackport_set_project_network_group", "stackport_set_project_paused", "stackport_update_project",
  ]);
});

test("the stdio server tells agents what the marker means", () => {
  assert.match(source, /Tools whose description starts with DESTRUCTIVE/);
});
