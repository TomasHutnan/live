import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hash } from "@node-rs/argon2";
import { type Browser, type BrowserContext, expect, type Page, test as base } from "@playwright/test";

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

  constructor(private readonly env: Record<string, string> = {}) {}

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
        ...this.env,
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

/** A TCP proxy a test can cut, to give one browser a real network drop. */
export class Proxy {
  private server?: Server;
  private readonly sockets = new Set<Socket>();
  port = 0;

  constructor(private readonly target: number) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async up(): Promise<void> {
    this.port ||= await freePort();
    this.server = createServer((client) => {
      const upstream = connect(this.target, "127.0.0.1");
      client.pipe(upstream).pipe(client);
      for (const socket of [client, upstream]) {
        this.sockets.add(socket);
        socket.on("error", () => {});
        socket.on("close", () => {
          this.sockets.delete(socket);
          client.destroy();
          upstream.destroy();
        });
      }
    });
    await new Promise<void>((resolve) => this.server!.listen(this.port, "127.0.0.1", resolve));
  }

  async down(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise((resolve) => this.server?.close(resolve));
  }
}

let counter = 0;
export const nextSlug = () => `s${process.pid}-${counter++}`;

export async function presenterContext(browser: Browser, viewport = { width: 1280, height: 800 }): Promise<BrowserContext> {
  return browser.newContext({ httpCredentials: { username: USER, password: PASSWORD }, viewport });
}

/** One server per worker: tests isolate themselves by slug. */
export const test = base.extend<
  { deckSlug: string; ownServer: (env?: Record<string, string>) => Promise<LiveServer> },
  { server: LiveServer; deckId: string }
>({
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
  // For tests that stop the server or change its settings. Always cleaned up.
  ownServer: async ({}, use) => {
    const started: LiveServer[] = [];
    await use(async (env) => {
      const server = new LiveServer(env);
      started.push(server);
      await server.start();
      return server;
    });
    await Promise.all(started.map((server) => server.dispose()));
  },
  deckSlug: async ({ server, deckId }, use) => {
    const slug = nextSlug();
    await server.createSession(slug, deckId);
    await use(slug);
  },
});

export { expect };

export const connected = (page: Page) => expect(page.locator("html")).toHaveAttribute("data-live-state", "connected");

export const position = (page: Page) =>
  page.evaluate(() => {
    const { h, v, f } = window.Reveal.getIndices();
    return { h, v, f: f ?? -1 };
  });

/** Jumps to the first slide with at least `steps` fragments, at step `f`, and reports where that is. */
export async function goToSteppedSlide(page: Page, f: number, steps = 3): Promise<{ h: number; v: number }> {
  return page.evaluate(
    ([f, steps]) => {
      const slide = (window.Reveal as unknown as { getSlides(): HTMLElement[] })
        .getSlides()
        .find((s) => new Set([...s.querySelectorAll(".fragment")].map((x) => x.getAttribute("data-fragment-index"))).size >= steps!);
      if (!slide) throw new Error("no stepped slide");
      const { h, v } = (window.Reveal as unknown as { getIndices(s: HTMLElement): { h: number; v: number } }).getIndices(slide);
      window.Reveal.slide(h, v, f);
      return { h, v };
    },
    [f, steps],
  );
}

export const tool = (page: Page, name: string) => page.getByRole("button", { name, exact: true }).click();

/** Viewport position of slide coordinates. */
export const slidePoint = (page: Page, x: number, y: number) =>
  page.evaluate(
    ([x, y]) => {
      const rect = document.querySelector(".reveal .slides")!.getBoundingClientRect();
      const { width, height } = window.Reveal.getConfig();
      return { x: rect.left + (x! / (width as number)) * rect.width, y: rect.top + (y! / (height as number)) * rect.height };
    },
    [x, y],
  );

/** Draws a straight stroke with the mouse, between slide coordinates. */
export async function draw(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  const a = await slidePoint(page, ...from);
  const b = await slidePoint(page, ...to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
}

/** Ids of ink elements on screen. */
export const inkIds = (page: Page) =>
  page.locator("#live-overlay g[data-item-id]").evaluateAll((nodes) => nodes.map((n) => (n as SVGGElement).dataset.itemId!).sort());

/** Bounding box of one ink element, in slide coordinates. */
export const inkBox = (page: Page, id: string) =>
  page.evaluate((id) => {
    const box = (document.querySelector(`#live-overlay g[data-item-id="${id}"]`) as SVGGElement).getBBox();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }, id);

export type { Page };
