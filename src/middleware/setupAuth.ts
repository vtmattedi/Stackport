import { Request, Response, NextFunction } from "express";
import { verifySetupToken, type VerifiedSetupToken } from "../services/setupTokens";
import type { SetupCredentialKind } from "../services/installation";

declare global {
  namespace Express {
    interface Request {
      setupAuth?: VerifiedSetupToken;
    }
  }
}

/** Gates routes/setup.ts's /admin and /recovery routes. Pass a kind to restrict a
 *  route to exactly that flow (bootstrap can't complete a recovery and vice versa) —
 *  everything else routes/setup.ts exposes (status, login) stays fully public. */
export function requireSetupAuth(kind?: SetupCredentialKind) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const verified = verifySetupToken(header.slice(7));
    if (!verified || (kind && verified.kind !== kind)) {
      res.status(401).json({ error: "Invalid or expired setup session" });
      return;
    }
    req.setupAuth = verified;
    next();
  };
}
