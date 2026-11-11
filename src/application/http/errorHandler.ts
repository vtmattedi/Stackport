import { Request, Response, NextFunction } from "express";
import { logger } from "../../shared/logger";

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  void _next;
  // A body the parser refused (too large, malformed) is the client's mistake: say so with its status, not a 500.
  const clientError = err as { status?: unknown; expose?: unknown } | null;
  if (clientError && typeof clientError.status === "number" && clientError.status >= 400 && clientError.status < 500 && clientError.expose === true) {
    logger.warn({ path: req.path, method: req.method, status: clientError.status }, "request refused");
    res.status(clientError.status).json({ error: clientError.status === 413 ? "Request body too large" : "The request could not be read" });
    return;
  }
  const message = err instanceof Error ? err.message : "Internal server error";
  logger.error({ err, path: req.path, method: req.method }, "unhandled error");
  // Never expose internal details in production
  res.status(500).json({
    error: process.env["NODE_ENV"] === "production" ? "Internal server error" : message,
  });
}
