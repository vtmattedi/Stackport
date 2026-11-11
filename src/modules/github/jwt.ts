import crypto from "crypto";

/** The App's own credential: a JWT signed with its private key, valid for at most ten minutes. GitHub asks for
 *  `iat` a minute in the past, to allow for clock drift between us and it. */
export function signAppJwt(appId: number, privateKeyPem: string, nowMs: number = Date.now()): string {
  const b64 = (value: object): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  const issuedAt = Math.floor(nowMs / 1000) - 60;
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: issuedAt, exp: issuedAt + 9 * 60 + 60, iss: String(appId) })}`;
  const signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(privateKeyPem).toString("base64url");
  return `${unsigned}.${signature}`;
}
