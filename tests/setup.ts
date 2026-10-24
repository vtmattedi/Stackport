// Loaded before every test file (see `npm test`). Each file runs in its own process,
// so each gets a fresh temp directory and database.
import fs from "fs";
import os from "os";
import path from "path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stackport-test-"));
process.env["JWT_SECRET"] ??= "test-jwt-secret";
process.env["WEBHOOK_SECRET"] ??= "test-webhook-secret";
process.env["NODE_ENV"] = "test";
process.env["SQLITE_PATH"] = path.join(dir, "stackport.sqlite");
process.env["DEPLOY_ROOT"] = path.join(dir, "repos");
process.env["SCRIPTS_DIR"] = path.join(dir, "scripts");
process.env["LOG_DIR"] = path.join(dir, "logs");
process.env["LOG_LEVEL"] = "error";

process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
