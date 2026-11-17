/* eslint-disable security/detect-non-literal-fs-filename -- the file is the archive Stackport itself just wrote. */
import crypto from "crypto";
import fs from "fs";
import { ticketRequest } from "../peers/client";
import { sha256OfFile } from "./fileHash";
import { CHUNK_MAX_BYTES } from "./transferIn";

/** What the target handed out for one transfer. It is the only thing the source holds for that instance. */
export interface PushTicket { endpoint: string; fingerprint: string | null; transferId: string; token: string }

export class PushError extends Error {
  constructor(message: string, readonly code: string) { super(message); }
}

const RETRIES = 5;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Sends `file` to the target's ticket endpoint in numbered, individually checked chunks, resuming from what the target already has, then asks it to check the whole.
 *  A lost answer repeats the chunk (the target accepts a repeat of the last one once); a refusal that retrying cannot fix stops at once. */
export async function pushArchive(file: string, ticket: PushTicket, options: { onProgress?: (sent: number, total: number) => void; shouldStop?: () => boolean; chunkBytes?: number; sleepMs?: (attempt: number) => number } = {}): Promise<{ size: number; sha256: string; chunks: number }> {
  const chunkBytes = Math.min(options.chunkBytes ?? CHUNK_MAX_BYTES, CHUNK_MAX_BYTES);
  const base = `/control/transfer/${ticket.transferId}`;
  const auth = { authorization: `Bearer ${ticket.token}` };
  const size = fs.statSync(file).size;
  const sha256 = await sha256OfFile(file);
  const call = (method: string, path: string, headers: Record<string, string>, body: Buffer): Promise<{ status: number; body: unknown }> =>
    ticketRequest(ticket.endpoint, ticket.fingerprint, method, path, { ...auth, ...headers }, body, 5 * 60 * 1000);

  // Where the target is: a retry of the whole push continues instead of starting over.
  const state = await call("GET", base, {}, Buffer.alloc(0));
  if (state.status !== 200) throw new PushError(`The target refused the transfer (${state.status}): ${errorOf(state.body)}`, "refused");
  let index = Number((state.body as { next?: number }).next ?? 0);
  const total = Math.ceil(size / chunkBytes);
  const fd = fs.openSync(file, "r");
  try {
    while (index < total) {
      if (options.shouldStop?.()) throw new PushError("The move was stopped.", "stopped");
      const buffer = Buffer.alloc(Math.min(chunkBytes, size - index * chunkBytes));
      fs.readSync(fd, buffer, 0, buffer.length, index * chunkBytes);
      const chunkSha = crypto.createHash("sha256").update(buffer).digest("hex");
      for (let attempt = 0; ; attempt += 1) {
        let answer: { status: number; body: unknown } | null = null;
        try {
          answer = await call("PUT", `${base}/chunks/${index}`, { "content-type": "application/octet-stream", "x-sp-chunk-sha256": chunkSha }, buffer);
        } catch (error) {
          // The connection dropped: whether the chunk arrived is unknown, and sending it again is safe.
          if (attempt >= RETRIES) throw new PushError(`The target could not be reached: ${error instanceof Error ? error.message : String(error)}`, "unreachable");
        }
        if (answer && answer.status === 200) break;
        if (answer && answer.status === 409 && (answer.body as { code?: string }).code === "out-of-order") {
          index = Number((answer.body as { next: number }).next) - 1; // resume from where the target is; the loop's increment lands on it
          break;
        }
        if (answer && answer.status < 500 && answer.status !== 429) throw new PushError(`The target refused chunk ${index} (${answer.status}): ${errorOf(answer.body)}`, "refused");
        if (attempt >= RETRIES) throw new PushError(`The target kept failing on chunk ${index}.`, "unreachable");
        await sleep(options.sleepMs ? options.sleepMs(attempt) : Math.min(30_000, 500 * 2 ** attempt));
      }
      index += 1;
      options.onProgress?.(Math.min(index * chunkBytes, size), size);
    }
  } finally { fs.closeSync(fd); }

  const done = await call("POST", `${base}/complete`, { "content-type": "application/json" }, Buffer.from(JSON.stringify({ chunks: total, size, sha256 })));
  if (done.status !== 200) throw new PushError(`The target did not accept the archive (${done.status}): ${errorOf(done.body)}`, "refused");
  return { size, sha256, chunks: total };
}

function errorOf(body: unknown): string {
  return typeof body === "object" && body && "error" in body ? String((body as { error: unknown }).error) : "no reason given";
}
