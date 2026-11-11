import pino from "pino";
import path from "path";
import fs from "fs";
import { config } from "../config/env";
import { pushAuditEntry, type AuditEntry } from "./auditStore";

export interface LoggerOptions {
  nodeEnv: string;
  logLevel: string;
  logDir: string;
  /** Where warnings and errors are repeated in production. `docker logs` reads this stream. */
  consoleStream?: NodeJS.WritableStream;
}

/** Development: pretty console output. Production: everything at the configured level goes to
 *  `app.log`, and warnings and errors also go to the console, so `docker logs` shows what went
 *  wrong without anyone having to open the file (P4). */
export function buildLogger(options: LoggerOptions): pino.Logger {
  if (options.nodeEnv === "development") {
    try {
      require.resolve("pino-pretty");
      return pino({
        level: options.logLevel,
        transport: { target: "pino-pretty", options: { colorize: true } },
      });
    } catch {
      return pino({ level: options.logLevel });
    }
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- paths come from Stackport's own configuration (environment and data directories), never from request input.
  fs.mkdirSync(options.logDir, { recursive: true });
  const file = pino.destination({ dest: path.join(options.logDir, "app.log"), sync: false });
  return pino(
    { level: options.logLevel },
    pino.multistream([
      { stream: file, level: options.logLevel },
      { stream: options.consoleStream ?? process.stdout, level: "warn" },
    ]),
  );
}

export const logger = buildLogger({ nodeEnv: config.nodeEnv, logLevel: config.logLevel, logDir: config.logDir });

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
