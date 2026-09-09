import jwt from "jsonwebtoken";
import { config } from "../config/env";
import type { SetupCredentialKind } from "./installation";

// Deliberately stateless (unlike authTokens.ts's DB-backed, revocable tokens) —
// setup tokens are short-lived and single-purpose, so there's nothing worth the
// overhead of a server-side session table for. The `typ` claim keeps this
// namespace disjoint from normal auth tokens: requireAuth's verifyStoredAuthToken
// looks up `jti` in auth_tokens (a setup token has none), and requireSetupAuth
// rejects anything without typ === "setup" — neither can be replayed as the other
// even though both are signed with the same JWT_SECRET.
const SETUP_TOKEN_TYP = "setup";
export const SETUP_TOKEN_TTL_S = 30 * 60;

export interface VerifiedSetupToken {
  kind: SetupCredentialKind;
  username: string;
}

export function issueSetupToken(kind: SetupCredentialKind, username: string): string {
  return jwt.sign({ typ: SETUP_TOKEN_TYP, kind, username }, config.jwtSecret, {
    expiresIn: SETUP_TOKEN_TTL_S,
  });
}

export function verifySetupToken(token: string): VerifiedSetupToken | null {
  let decoded: string | jwt.JwtPayload;
  try {
    decoded = jwt.verify(token, config.jwtSecret);
  } catch {
    return null;
  }
  if (typeof decoded === "string") return null;
  if (decoded["typ"] !== SETUP_TOKEN_TYP) return null;
  const kind = decoded["kind"];
  const username = decoded["username"];
  if (kind !== "bootstrap" && kind !== "recovery") return null;
  if (typeof username !== "string") return null;
  return { kind, username };
}
