import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Asset {
  body: Buffer;
  etag: string;
  type: string;
}

/** Bundled browser code, read once at startup. dist/server.js sits next to dist/public. */
export function loadAssets(dir = join(dirname(fileURLToPath(import.meta.url)), "public")): Map<string, Asset> {
  const assets = new Map<string, Asset>();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".js")) continue;
    const body = readFileSync(join(dir, name));
    const etag = `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`;
    assets.set(name, { body, etag, type: "text/javascript; charset=utf-8" });
  }
  return assets;
}
