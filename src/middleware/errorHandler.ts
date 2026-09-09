import { Request, Response, NextFunction } from "express";
import { logger } from "../utils/logger";

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  void _next;
  const message = err instanceof Error ? err.message : "Internal server error";
  logger.error({ err, path: req.path, method: req.method }, "unhandled error");
  // Never expose internal details in production
  res.status(500).json({
    error: process.env["NODE_ENV"] === "production" ? "Internal server error" : message,
  });
}
