import crypto from "crypto";
import { config } from "../config/env";

/**
 * Encryption of stored secrets (S7).
 *
 * Secrets used to be encrypted with a key derived from JWT_SECRET, so rotating the session
 * secret broke every stored credential and leaking it exposed them all. Now:
 *
 *  - ENCRYPTION_KEY is its own key. New ciphertext is `v2:<keyId>:<iv>:<tag>:<data>`,
 *    where keyId names the key that made it, so any key in the ring can decrypt it.
 *  - ENCRYPTION_KEY_PREVIOUS (comma separated) keeps older keys readable while a rotation
 *    is in progress. Settings > Migrations re-encrypts everything with the current key.
 *  - Ciphertext from before this change has no prefix (`<iv>:<tag>:<data>`) and is read with
 *    the JWT-derived key. It stays readable until it is re-encrypted; rotate JWT_SECRET only
 *    after that.
 *  - With no ENCRYPTION_KEY configured, nothing changes: the JWT-derived key stays current
 *    and the old format is written, so an install is not broken by updating before
 *    `stackport repair` has generated the key.
 */

export const LEGACY_KEY_ID = "legacy";

export interface Keyring {
  /** Encrypts with the current key. */
  encrypt(plaintext: string): string;
  decrypt(stored: string): string;
  /** The id of the key that made `stored`, or "legacy" for the old format. */
  keyIdOf(stored: string): string;
  /** The id new ciphertext is written under. */
  currentKeyId: string;
}

function deriveKey(secret: string): Buffer {
  return crypto.createHash("sha256").update(secret).digest();
}

function idOf(key: Buffer): string {
  return crypto.createHash("sha256").update("stackport-key-id:").update(key).digest("hex").slice(0, 8);
}

function seal(key: Buffer, plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv.toString("hex"), cipher.getAuthTag().toString("hex"), encrypted.toString("hex")].join(":");
}

function open(key: Buffer, ivHex: string, tagHex: string, dataHex: string): string {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
}

export function createKeyring(options: { jwtSecret: string; encryptionKey?: string; previousKeys?: string[] }): Keyring {
  const legacy = deriveKey(options.jwtSecret);
  const current = options.encryptionKey ? deriveKey(options.encryptionKey) : null;
  const ring = new Map<string, Buffer>();
  for (const secret of [options.encryptionKey, ...(options.previousKeys ?? [])]) {
    if (!secret) continue;
    const key = deriveKey(secret);
    ring.set(idOf(key), key);
  }

  return {
    currentKeyId: current ? idOf(current) : LEGACY_KEY_ID,
    encrypt: (plaintext) => (current ? `v2:${idOf(current)}:${seal(current, plaintext)}` : seal(legacy, plaintext)),
    decrypt: (stored) => {
      const parts = stored.split(":");
      if (parts.length === 3) return open(legacy, parts[0], parts[1], parts[2]);
      if (parts.length === 5 && parts[0] === "v2") {
        const key = ring.get(parts[1]);
        if (!key) throw new Error(`No encryption key with id ${parts[1]} is configured`);
        return open(key, parts[2], parts[3], parts[4]);
      }
      throw new Error("Malformed stored secret");
    },
    keyIdOf: (stored) => {
      const parts = stored.split(":");
      if (parts.length === 5 && parts[0] === "v2") return parts[1];
      if (parts.length === 3) return LEGACY_KEY_ID;
      throw new Error("Malformed stored secret");
    },
  };
}

const keyring = createKeyring({
  jwtSecret: config.jwtSecret,
  encryptionKey: config.encryptionKey,
  previousKeys: config.encryptionKeysPrevious,
});

export function encryptSecret(plaintext: string): string {
  return keyring.encrypt(plaintext);
}

export function decryptSecret(stored: string): string {
  return keyring.decrypt(stored);
}

export const currentKeyId = keyring.currentKeyId;

export function secretKeyId(stored: string): string {
  return keyring.keyIdOf(stored);
}
