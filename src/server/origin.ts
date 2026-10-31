import type { Config } from "./config.ts";

/** True when an Origin header names this site. `host` is the request's effective host. */
export function originMatches(origin: string, host: string | undefined, config: Pick<Config, "publicOrigin">): boolean {
  if (config.publicOrigin) return origin === config.publicOrigin;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false; // Includes the opaque "null" origin.
  }
}

/**
 * Basic credentials travel with cross-site requests, so a non-GET request with
 * a foreign Origin is refused. No Origin means a non-browser client such as
 * curl, which only gets through with real credentials.
 */
export function allowsUnsafeRequest(
  origin: string | undefined,
  host: string | undefined,
  config: Pick<Config, "publicOrigin">,
): boolean {
  return origin === undefined || originMatches(origin, host, config);
}
