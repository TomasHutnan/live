import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hash } from "@node-rs/argon2";
import { type Browser, type BrowserContext, type Page, test as base } from "@playwright/test";

export const USER = "tomas";
export const PASSWORD = "skúška-heslo";
export const fixturePath = join(import.meta.dirname, "..", "fixtures", "pb016-cv05.html");
const passwordHash = hash(PASSWORD, { algorithm: 2 });

export const basicHeader = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

export class LiveServer {
  private child?: ChildProcess;
  readonly dataDir = mkdtempSync(join(tmpdir(), "live-e2e-"));
  port = 0;

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    this.port ||= await freePort();
    this.child = spawn(process.execPath, ["dist/server.js"], {
      stdio: ["ignore", "ignore", "inherit"],
      env: {
        ...process.env,
        PORT: String(this.port),
        HOST: "127.0.0.1",
        LIVE_DATA_DIR: this.dataDir,
        LIVE_ADMIN_USER: USER,
        LIVE_ADMIN_PASSWORD_HASH: await passwordHash,
        LIVE_HEARTBEAT_MS: "2000",
        LOG_LEVEL: "error",
      },
    });
    for (let i = 0; i < 100; i++) {
      const ok = await fetch(`${this.url}/healthz`).then((r) => r.ok, () => false);
      if (ok) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("server did not start");
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
    });
  }

  async dispose(): Promise<void> {
    await this.stop();
    rmSync(this.dataDir, { recursive: true, force: true });
  }

  async request(method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(this.url + path, { method, body, headers: { Authorization: basicHeader, ...headers } });
  }

  async upload(html: string | Buffer = readFileSync(fixturePath), filename = "cv05.html"): Promise<{ id: string }> {
    const form = new FormData();
    form.append("file", new Blob([html as BlobPart], { type: "text/html" }), filename);
    const response = await this.request("POST", "/api/decks", form);
    if (!response.ok) throw new Error(`upload: ${response.status} ${await response.text()}`);
    return ((await response.json()) as { deck: { id: string } }).deck;
  }

  async createSession(slug: string, deckId: string): Promise<void> {
    const response = await this.request(
      "POST",
      "/api/sessions",
      JSON.stringify({ slug, deckId, title: slug }),
      { "Content-Type": "application/json" },
    );
    if (!response.ok) throw new Error(`session: ${response.status} ${await response.text()}`);
  }

  async removeSession(slug: string): Promise<void> {
    const response = await this.request(
      "DELETE",
      `/api/sessions/${slug}`,
      JSON.stringify({ confirm: slug }),
      { "Content-Type": "application/json" },
    );
    if (!response.ok) throw new Error(`remove: ${response.status}`);
  }
}

let counter = 0;
export const nextSlug = () => `s${process.pid}-${counter++}`;

export async function presenterContext(browser: Browser, viewport = { width: 1280, height: 800 }): Promise<BrowserContext> {
  return browser.newContext({ httpCredentials: { username: USER, password: PASSWORD }, viewport });
}

/** One server per worker: tests isolate themselves by slug. */
export const test = base.extend<{ deckSlug: string }, { server: LiveServer; deckId: string }>({
  server: [
    async ({}, use) => {
      const server = new LiveServer();
      await server.start();
      await use(server);
      await server.dispose();
    },
    { scope: "worker" },
  ],
  deckId: [
    async ({ server }, use) => {
      const deck = await server.upload();
      await use(deck.id);
    },
    { scope: "worker" },
  ],
  deckSlug: async ({ server, deckId }, use) => {
    const slug = nextSlug();
    await server.createSession(slug, deckId);
    await use(slug);
  },
});

export { expect } from "@playwright/test";

export type { Page };
