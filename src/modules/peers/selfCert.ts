import { X509Certificate } from "crypto";
import { promises as fs } from "fs";
import { SELF_SIGNED_CERT_PATH } from "../ingress/nginx/selfSignedCert";

/** The SHA-256 fingerprint of this instance's self-signed certificate, which a peer pins when this instance has no real one yet. Null once there is none. */
export async function selfSignedFingerprint(): Promise<string | null> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a fixed path, not user input
  try { return new X509Certificate(await fs.readFile(SELF_SIGNED_CERT_PATH)).fingerprint256; } catch { return null; }
}
