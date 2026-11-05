import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import ts from "typescript";

const root = path.resolve(__dirname, "../src");
const legacy = new Set(["services", "routes", "entities", "middleware", "mcp", "utils"]);
function files(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? files(filename) : filename.endsWith(".ts") && !filename.endsWith(".d.ts") ? [filename] : [];
  });
}
function isLegacy(file: string): boolean { return legacy.has(path.relative(root, file).split(path.sep)[0]); }
function resolve(file: string, specifier: string): string {
  const base = path.resolve(path.dirname(file), specifier);
  const found = [`${base}.ts`, path.join(base, "index.ts")].find(candidate => fs.existsSync(candidate));
  assert.ok(found, `Unresolved local module ${specifier} in ${file}`);
  return found;
}
function moduleEdges(file: string, includeTypes: boolean): string[] {
  const ast = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  return ast.statements.flatMap(node => {
    if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) return [];
    if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier) || !node.moduleSpecifier.text.startsWith(".")) return [];
    if (!includeTypes) {
      if (ts.isImportDeclaration(node)) {
        if (node.importClause?.isTypeOnly) return [];
        const bindings = node.importClause?.namedBindings;
        if (!node.importClause?.name && bindings && ts.isNamedImports(bindings) && bindings.elements.length && bindings.elements.every(element => element.isTypeOnly)) return [];
      } else {
        if (node.isTypeOnly) return [];
        if (node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length && node.exportClause.elements.every(element => element.isTypeOnly)) return [];
      }
    }
    return [resolve(file, node.moduleSpecifier.text)];
  });
}

test("the retired services directory cannot be reintroduced", () => {
  assert.equal(fs.existsSync(path.join(root, "services")), false);
});

test("application implementations cannot depend on legacy compatibility directories", () => {
  for (const file of files(root).filter(file => !isLegacy(file))) {
    for (const dependency of moduleEdges(file, true)) assert.equal(isLegacy(dependency), false, `${file} imports legacy ${dependency}`);
  }
});

test("legacy source directories contain only direct compatibility exports", () => {
  for (const file of files(root).filter(isLegacy)) {
    const ast = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    assert.ok(ast.statements.length, `Empty compatibility file ${file}`);
    assert.ok(ast.statements.every(node => ts.isExportDeclaration(node)), `Business logic returned to ${file}`);
    for (const dependency of moduleEdges(file, true)) assert.equal(isLegacy(dependency), false, `Compatibility chain in ${file}`);
  }
});

test("runtime import and re-export dependencies remain acyclic", () => {
  const graph = new Map(files(root).map(file => [file, moduleEdges(file, false)]));
  const visiting = new Set<string>(); const visited = new Set<string>();
  function visit(file: string): void {
    assert.equal(visiting.has(file), false, `Runtime dependency cycle at ${file}`);
    if (visited.has(file)) return;
    visiting.add(file);
    for (const dependency of graph.get(file) ?? []) visit(dependency);
    visiting.delete(file); visited.add(file);
  }
  for (const file of graph.keys()) visit(file);
});
