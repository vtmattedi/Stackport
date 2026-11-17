/* eslint-disable security/detect-non-literal-fs-filename -- the file is an archive Stackport itself wrote or received. */
import crypto from "crypto";
import fs from "fs";

/** SHA-256 of a file, streamed: an archive can be many gigabytes, and hashing it must not hold up the rest of the server. */
export function sha256OfFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file).on("data", (chunk) => hash.update(chunk)).on("error", reject).on("end", () => resolve(hash.digest("hex")));
  });
}
