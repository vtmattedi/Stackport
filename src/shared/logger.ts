import pino from "pino";
import path from "path";
import fs from "fs";
import { config } from "../config/env";
import { pushAuditEntry, type AuditEntry } from "./auditStore";

function buildLogger(): pino.Logger {
  if (config.nodeEnv === "development") {
    try {
      require.resolve("pino-pretty");
      return pino({
        level: config.logLevel,
        transport: { target: "pino-pretty", options: { colorize: true } },
      });
    } catch {
      return pino({ level: config.logLevel });
    }
  }
  fs.mkdirSync(config.logDir, { recursive: true });
  return pino(
    { level: config.logLevel },
    pino.destination({ dest: path.join(config.logDir, "app.log"), sync: false })
  );
}

export const logger = buildLogger();

export function auditLog(
  actor: string,
  action: string,
  target: string,
  result: "ok" | "fail",
  meta?: Record<string, unknown>
): void {
  const entry: AuditEntry = {
    ts: new Date().toISOString(),
    actor,
    action,
    target,
    result,
    meta,
  };
  pushAuditEntry(entry);
  logger.info({ audit: true, ...entry });
}
