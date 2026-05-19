/**
 * Streaming sha256 hash for files of any size. Stream-based so a 200 MB
 * PDF doesn't blow the heap.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export async function hashFile(absolutePath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(absolutePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
