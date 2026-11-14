/* eslint-disable security/detect-non-literal-fs-filename -- paths are the operator's own CLI arguments, Stackport's configured data directories, or names Stackport enumerated and validated itself (archive entry names pass isSafeEntryName). */
import crypto from "crypto";
import fs from "fs";
import path from "path";

/**
 * The portable backup container: one passphrase-encrypted file holding named entries.
 *
 *   "SPBACKUP" | version u8 | salt 16 | scrypt log2(N) u8 | nonce prefix 4        (the header)
 *   then chunks:  length u32 | final u8 | ciphertext | GCM tag 16
 *
 * Every chunk is AES-256-GCM under a key from scrypt(passphrase, salt). The nonce is the
 * header's random prefix plus the chunk counter, so chunks cannot be reordered or replayed;
 * the header and the "final" flag are authenticated data, so a truncated file (final chunk
 * missing) or an edited header fails instead of reading as a shorter archive. A wrong
 * passphrase and a damaged file fail the same way, at the first chunk.
 *
 * Inside, the plaintext is a sequence of `nameLength u16 | name | size u64 | bytes` entries
 * ending with a zero-length name. Only regular files: no links, no directories, no modes.
 */

const MAGIC = Buffer.from("SPBACKUP", "ascii");
const FORMAT_VERSION = 1;
const SALT_BYTES = 16;
const NONCE_PREFIX_BYTES = 4;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + 1 + SALT_BYTES + 1 + NONCE_PREFIX_BYTES;
const CHUNK_BYTES = 64 * 1024;
const SCRYPT_LOG2_N = 15;
const MAX_NAME_BYTES = 1024;

export class ArchiveError extends Error {
  constructor(message: string, readonly code: "wrong-passphrase-or-corrupt" | "truncated" | "unsupported" | "malformed" | "unsafe-path") {
    super(message);
    this.name = "ArchiveError";
  }
}

function deriveKey(passphrase: string, salt: Buffer, log2N: number): Buffer {
  const cost = 2 ** log2N;
  return crypto.scryptSync(passphrase.normalize("NFKC"), salt, 32, { N: cost, r: 8, p: 1, maxmem: 128 * cost * 8 + 1024 * 1024 });
}

function nonceFor(prefix: Buffer, counter: number): Buffer {
  const nonce = Buffer.alloc(12);
  prefix.copy(nonce, 0);
  nonce.writeBigUInt64BE(BigInt(counter), NONCE_PREFIX_BYTES);
  return nonce;
}

/** Entry names are relative, forward-slash paths with no `.`/`..` segments, so extraction cannot leave its directory. */
export function isSafeEntryName(name: string): boolean {
  if (!name || Buffer.byteLength(name) > MAX_NAME_BYTES) return false;
  if (name.includes("\\") || name.includes("\0") || name.startsWith("/") || /^[a-zA-Z]:/.test(name)) return false;
  return name.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export class ArchiveWriter {
  private readonly fd: number;
  private readonly key: Buffer;
  private readonly header: Buffer;
  private readonly noncePrefix: Buffer;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private counter = 0;
  private finished = false;
  private readonly names = new Set<string>();

  constructor(private readonly filePath: string, passphrase: string) {
    if (!passphrase) throw new ArchiveError("A passphrase is required to write an archive.", "unsupported");
    const salt = crypto.randomBytes(SALT_BYTES);
    this.noncePrefix = crypto.randomBytes(NONCE_PREFIX_BYTES);
    this.key = deriveKey(passphrase, salt, SCRYPT_LOG2_N);
    this.header = Buffer.concat([MAGIC, Buffer.from([FORMAT_VERSION]), salt, Buffer.from([SCRYPT_LOG2_N]), this.noncePrefix]);
    this.fd = fs.openSync(filePath, "wx", 0o600);
    fs.writeSync(this.fd, this.header);
  }

  private seal(plain: Buffer, final: boolean): void {
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, nonceFor(this.noncePrefix, this.counter));
    const finalByte = Buffer.from([final ? 1 : 0]);
    cipher.setAAD(Buffer.concat([this.header, finalByte]));
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    fs.writeSync(this.fd, Buffer.concat([length, finalByte, body, cipher.getAuthTag()]));
    this.counter += 1;
  }

  private write(bytes: Buffer): void {
    this.pending.push(bytes);
    this.pendingBytes += bytes.length;
    if (this.pendingBytes < CHUNK_BYTES) return;
    // Join once, seal every full chunk by slicing, keep only the remainder: linear in the input size.
    const all = Buffer.concat(this.pending);
    let offset = 0;
    while (all.length - offset >= CHUNK_BYTES) {
      this.seal(all.subarray(offset, offset + CHUNK_BYTES), false);
      offset += CHUNK_BYTES;
    }
    const rest = all.subarray(offset);
    this.pending = rest.length ? [rest] : [];
    this.pendingBytes = rest.length;
  }

  private begin(name: string, size: number): void {
    if (this.finished) throw new ArchiveError("The archive is already finished.", "unsupported");
    if (!isSafeEntryName(name)) throw new ArchiveError(`Unsafe entry name: ${name}`, "unsafe-path");
    if (this.names.has(name)) throw new ArchiveError(`Duplicate entry: ${name}`, "malformed");
    this.names.add(name);
    const nameBytes = Buffer.from(name, "utf8");
    const head = Buffer.alloc(2 + nameBytes.length + 8);
    head.writeUInt16BE(nameBytes.length, 0);
    nameBytes.copy(head, 2);
    head.writeBigUInt64BE(BigInt(size), 2 + nameBytes.length);
    this.write(head);
  }

  addBuffer(name: string, data: Buffer): void {
    this.begin(name, data.length);
    this.write(data);
  }

  addFile(name: string, source: string): void {
    const fd = fs.openSync(source, "r");
    try {
      const size = fs.fstatSync(fd).size;
      this.begin(name, size);
      const buffer = Buffer.alloc(CHUNK_BYTES);
      let remaining = size;
      while (remaining > 0) {
        const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, remaining), null);
        if (read === 0) throw new ArchiveError(`${source} shrank while it was being archived.`, "malformed");
        this.write(Buffer.from(buffer.subarray(0, read)));
        remaining -= read;
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.write(Buffer.alloc(2)); // the zero-length name that ends the entries
    const rest = Buffer.concat(this.pending);
    this.seal(rest, true);
    fs.fsyncSync(this.fd);
    fs.closeSync(this.fd);
  }

  /** Abandons a half-written archive: closes and removes the file. */
  abort(): void {
    if (!this.finished) {
      this.finished = true;
      try { fs.closeSync(this.fd); } catch { /* already closed */ }
    }
    fs.rmSync(this.filePath, { force: true });
  }
}

export interface EntryHandle {
  name: string;
  size: number;
  /** Reads up to `bytes` of this entry (fewer at its end). */
  read(bytes: number): Buffer;
}

/** Plaintext of the whole archive as a pull stream of authenticated chunks. */
class PlainReader {
  private readonly fd: number;
  private readonly header: Buffer;
  private readonly key: Buffer;
  private readonly noncePrefix: Buffer;
  private counter = 0;
  private buffer: Buffer = Buffer.alloc(0);
  private sawFinal = false;

  constructor(filePath: string, passphrase: string) {
    this.fd = fs.openSync(filePath, "r");
    try {
      const header = Buffer.alloc(HEADER_BYTES);
      if (fs.readSync(this.fd, header, 0, HEADER_BYTES, null) < HEADER_BYTES || !header.subarray(0, MAGIC.length).equals(MAGIC)) {
        throw new ArchiveError("This is not a Stackport backup archive.", "malformed");
      }
      if (header[MAGIC.length] !== FORMAT_VERSION) {
        throw new ArchiveError(`Archive format version ${header[MAGIC.length]} is not supported by this Stackport (it reads version ${FORMAT_VERSION}).`, "unsupported");
      }
      const saltStart = MAGIC.length + 1;
      const log2N = header[saltStart + SALT_BYTES];
      if (log2N < 14 || log2N > 20) throw new ArchiveError("The archive's key-derivation parameters are out of range.", "malformed");
      this.header = header;
      this.noncePrefix = header.subarray(saltStart + SALT_BYTES + 1);
      this.key = deriveKey(passphrase, header.subarray(saltStart, saltStart + SALT_BYTES), log2N);
    } catch (error) {
      fs.closeSync(this.fd);
      throw error;
    }
  }

  private nextChunk(): boolean {
    if (this.sawFinal) return false;
    const prefix = Buffer.alloc(5);
    if (fs.readSync(this.fd, prefix, 0, 5, null) < 5) throw new ArchiveError("The archive is truncated.", "truncated");
    const length = prefix.readUInt32BE(0);
    if (length > CHUNK_BYTES) throw new ArchiveError("The archive is damaged (oversized chunk).", "malformed");
    const body = Buffer.alloc(length + TAG_BYTES);
    if (fs.readSync(this.fd, body, 0, body.length, null) < body.length) throw new ArchiveError("The archive is truncated.", "truncated");
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, nonceFor(this.noncePrefix, this.counter));
    decipher.setAAD(Buffer.concat([this.header, prefix.subarray(4, 5)]));
    decipher.setAuthTag(body.subarray(length));
    let plain: Buffer;
    try {
      plain = Buffer.concat([decipher.update(body.subarray(0, length)), decipher.final()]);
    } catch {
      throw new ArchiveError("Wrong passphrase, or the archive is corrupted.", "wrong-passphrase-or-corrupt");
    }
    this.counter += 1;
    this.sawFinal = prefix[4] === 1;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, plain]) : plain;
    return true;
  }

  /** Exactly `bytes` bytes, or fewer only if `allowShort` and the archive ends. */
  take(bytes: number): Buffer {
    while (this.buffer.length < bytes) {
      if (!this.nextChunk()) throw new ArchiveError("The archive ends inside an entry.", "truncated");
    }
    const out = this.buffer.subarray(0, bytes);
    this.buffer = this.buffer.subarray(bytes);
    return out;
  }

  /** After the end marker: the file must have no further chunks. */
  assertEnded(): void {
    while (!this.sawFinal) this.nextChunk();
    if (this.buffer.length) throw new ArchiveError("The archive has data after its end marker.", "malformed");
    const probe = Buffer.alloc(1);
    if (fs.readSync(this.fd, probe, 0, 1, null) !== 0) throw new ArchiveError("The archive has data after its final chunk.", "malformed");
  }

  close(): void {
    fs.closeSync(this.fd);
  }
}

/**
 * Walks every entry in order. `visit` must consume the entry (or return without reading, in
 * which case the rest is skipped). Throws on any authentication or structure failure, and
 * only returns once the whole file has been authenticated to its final chunk.
 */
export function readArchive(filePath: string, passphrase: string, visit: (entry: EntryHandle) => void | "stop"): void {
  const reader = new PlainReader(filePath, passphrase);
  try {
    const seen = new Set<string>();
    for (;;) {
      const nameLength = reader.take(2).readUInt16BE(0);
      if (nameLength === 0) break;
      if (nameLength > MAX_NAME_BYTES) throw new ArchiveError("The archive is damaged (entry name too long).", "malformed");
      const name = reader.take(nameLength).toString("utf8");
      if (!isSafeEntryName(name)) throw new ArchiveError(`The archive contains an unsafe path: ${name}`, "unsafe-path");
      if (seen.has(name)) throw new ArchiveError(`The archive repeats the entry ${name}.`, "malformed");
      seen.add(name);
      const sizeBig = reader.take(8).readBigUInt64BE(0);
      if (sizeBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new ArchiveError("The archive is damaged (entry size).", "malformed");
      const size = Number(sizeBig);
      let remaining = size;
      const handle: EntryHandle = {
        name,
        size,
        read(bytes) {
          const n = Math.min(bytes, remaining);
          if (n === 0) return Buffer.alloc(0);
          remaining -= n;
          return reader.take(n);
        },
      };
      if (visit(handle) === "stop") return;
      while (remaining > 0) handle.read(Math.min(remaining, CHUNK_BYTES));
    }
    reader.assertEnded();
  } finally {
    reader.close();
  }
}

/** Reads one entry fully into memory (for the manifest and the small env file). */
export function readEntryBuffer(entry: EntryHandle, maxBytes: number): Buffer {
  if (entry.size > maxBytes) throw new ArchiveError(`${entry.name} is larger than the ${maxBytes} byte limit.`, "malformed");
  const parts: Buffer[] = [];
  let left = entry.size;
  while (left > 0) {
    const part = entry.read(Math.min(left, CHUNK_BYTES));
    parts.push(Buffer.from(part));
    left -= part.length;
  }
  return Buffer.concat(parts);
}

/** Streams an entry to a new file under `root` (created with parents), returning its size and SHA-256. */
export function writeEntryTo(entry: EntryHandle, root: string): { size: number; sha256: string } {
  const target = path.join(root, ...entry.name.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const fd = fs.openSync(target, "wx", 0o600);
  const hash = crypto.createHash("sha256");
  try {
    let left = entry.size;
    while (left > 0) {
      const part = entry.read(Math.min(left, CHUNK_BYTES));
      hash.update(part);
      fs.writeSync(fd, part);
      left -= part.length;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { size: entry.size, sha256: hash.digest("hex") };
}
