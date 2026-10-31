import { join } from "node:path";

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  adminUser: string;
  adminPasswordHash: string;
  /** Exact site origin, e.g. https://live.hutnan.dev. Empty means "use the Host header". */
  publicOrigin: string;
  /** Passed to Fastify's trustProxy: only these peers may set X-Forwarded-*. */
  trustProxy: string[];
  heartbeatMs: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required (see .env.example)`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 8090),
    host: env.HOST ?? "0.0.0.0",
    dataDir: env.LIVE_DATA_DIR ?? "/data",
    adminUser: required(env, "LIVE_ADMIN_USER"),
    adminPasswordHash: required(env, "LIVE_ADMIN_PASSWORD_HASH"),
    publicOrigin: (env.LIVE_PUBLIC_ORIGIN ?? "").replace(/\/$/, ""),
    // The port is published on the host's loopback only, so the peer is always
    // the local Caddy: directly, through Docker's gateway, or on a shared
    // Docker network. Those are the loopback and private ranges.
    trustProxy: (env.LIVE_TRUST_PROXY ?? "loopback,uniquelocal").split(",").map((s) => s.trim()),
    heartbeatMs: Number(env.LIVE_HEARTBEAT_MS ?? 25_000),
  };
}

export const decksDir = (config: Config) => join(config.dataDir, "decks");
export const dbPath = (config: Config) => join(config.dataDir, "live.db");
