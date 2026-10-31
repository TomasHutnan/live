import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

// dist/server.js and src/server/db.ts both find it from the repository root.
const here = dirname(fileURLToPath(import.meta.url));
const defaultMigrations = here.endsWith(join("src", "server"))
  ? join(here, "..", "..", "migrations")
  : join(here, "..", "migrations");

export function openDb(path: string, migrationsDir = defaultMigrations): Database.Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  migrate(db, migrationsDir);
  return db;
}

/** Applies NNN_name.sql files above PRAGMA user_version, each in a transaction. */
export function migrate(db: Database.Database, dir: string): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  const files = readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  for (const file of files) {
    const version = Number.parseInt(file, 10);
    if (version <= current) continue;
    db.transaction(() => {
      db.exec(readFileSync(join(dir, file), "utf8"));
      db.pragma(`user_version = ${version}`);
    })();
  }
}
