import { createReadStream } from "node:fs";
import multipart from "@fastify/multipart";
import type Database from "better-sqlite3";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import QRCode from "qrcode";
import { isValidSlug, RESERVED_SLUGS } from "../shared/slug.ts";
import { type Asset, loadAssets } from "./assets.ts";
import { BasicAuth } from "./auth.ts";
import { type Config, decksDir } from "./config.ts";
import { DeckFiles, MAX_UPLOAD_BYTES, UploadError } from "./decks.ts";
import { allowsUnsafeRequest } from "./origin.ts";
import { dashboardPage, notFoundPage } from "./pages.ts";
import { Rooms } from "./rooms.ts";
import { type Deck, type Session, Store } from "./store.ts";

const HTML = "text/html; charset=utf-8";

export async function buildApp(config: Config, db: Database.Database): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    trustProxy: config.trustProxy,
  });
  const auth = new BasicAuth(config.adminUser, config.adminPasswordHash);
  const store = new Store(db);
  const files = new DeckFiles(decksDir(config), store);
  const assets = loadAssets();
  const rooms = new Rooms();
  const guarded = { preHandler: auth.guard };

  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Content-Security-Policy", "frame-ancestors 'self'");
    if (request.method === "GET" || request.method === "HEAD") return;
    if (!allowsUnsafeRequest(request.headers.origin, request.host, config)) {
      await reply.code(403).type("text/plain; charset=utf-8").send("Cross-site request refused.\n");
    }
  });

  const siteOrigin = (request: FastifyRequest) => config.publicOrigin || `${request.protocol}://${request.host}`;

  function notFound(reply: FastifyReply) {
    return reply.code(404).type(HTML).send(notFoundPage());
  }

  function sendDeck(request: FastifyRequest, reply: FastifyReply, deck: Deck, cache: string) {
    const etag = `"${deck.hash}"`;
    reply.header("ETag", etag).header("Cache-Control", cache);
    if (request.headers["if-none-match"] === etag) return reply.code(304).send();
    return reply.type(HTML).send(createReadStream(files.servedPath(deck)));
  }

  /** Looks up the session and deck behind a slug, or answers 404. */
  async function withSession(
    request: FastifyRequest,
    reply: FastifyReply,
    run: (session: Session, deck: Deck) => unknown,
  ) {
    const { slug } = request.params as { slug: string };
    const session = store.session(slug);
    const deck = session && store.deck(session.deckId);
    if (!session || !deck) return notFound(reply);
    return run(session, deck);
  }

  function sendAsset(request: FastifyRequest, reply: FastifyReply, asset: Asset) {
    reply.header("ETag", asset.etag).header("Cache-Control", "no-cache");
    if (request.headers["if-none-match"] === asset.etag) return reply.code(304).send();
    return reply.type(asset.type).send(asset.body);
  }

  app.get("/healthz", async () => {
    db.prepare("SELECT 1").get();
    return { ok: true };
  });

  app.get("/assets/:name", async (request, reply) => {
    const asset = assets.get((request.params as { name: string }).name);
    return asset ? sendAsset(request, reply, asset) : notFound(reply);
  });

  app.get("/", async (_request, reply) => reply.redirect("/dashboard"));

  app.get("/dashboard", guarded, async (_request, reply) =>
    reply.type(HTML).header("Cache-Control", "no-store").send(dashboardPage()),
  );

  // Dashboard API

  app.get("/api/state", guarded, async (request, reply) => {
    const origin = siteOrigin(request);
    const decks = store.decks();
    const titles = new Map(decks.map((d) => [d.id, d.title]));
    return reply.header("Cache-Control", "no-store").send({
      origin,
      sessions: store.sessions().map((s) => ({
        slug: s.slug,
        title: s.title,
        deckTitle: titles.get(s.deckId) ?? "",
        createdAt: s.createdAt,
        items: store.itemCount(s.slug),
        ...rooms.counts(s.slug),
      })),
      decks: decks.map((d) => ({
        id: d.id,
        title: d.title,
        filename: d.filename,
        size: d.size,
        uploadedAt: d.uploadedAt,
        sessions: store.sessionCountForDeck(d.id),
      })),
    });
  });

  app.post("/api/decks", guarded, async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.code(400).send({ error: "Send the deck as multipart/form-data, in a field called file." });
    }
    let bytes: Buffer;
    let filename: string;
    try {
      const part = await request.file();
      if (!part) return reply.code(400).send({ error: "No file in the upload." });
      bytes = await part.toBuffer();
      filename = part.filename || "deck.html";
    } catch (error) {
      if ((error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
        return reply.code(413).send({ error: "The deck is larger than the 50 MB limit." });
      }
      throw error;
    }
    try {
      const result = files.ingest(bytes, filename);
      return reply.code(result.existing ? 200 : 201).send(result);
    } catch (error) {
      if (error instanceof UploadError) return reply.code(422).send({ error: error.message });
      throw error;
    }
  });

  app.delete("/api/decks/:id", guarded, async (request, reply) => {
    const deck = store.deck((request.params as { id: string }).id);
    if (!deck) return reply.code(404).send({ error: "No such deck." });
    if (store.sessionCountForDeck(deck.id) > 0) {
      return reply.code(409).send({ error: "This deck is still used by a session." });
    }
    files.remove(deck);
    return reply.code(204).send();
  });

  app.post("/api/sessions", guarded, async (request, reply) => {
    const { slug, deckId, title } = (request.body ?? {}) as Record<string, unknown>;
    if (typeof slug !== "string" || !isValidSlug(slug)) {
      const reserved = typeof slug === "string" && RESERVED_SLUGS.has(slug);
      return reply.code(400).send({
        error: reserved
          ? `"${slug}" is a reserved word.`
          : "A slug is 2-41 lower-case letters, digits or hyphens, and starts with a letter or digit.",
      });
    }
    const deck = typeof deckId === "string" ? store.deck(deckId) : undefined;
    if (!deck) return reply.code(400).send({ error: "Choose a deck." });
    if (store.session(slug)) return reply.code(409).send({ error: `The session ${slug} already exists.` });
    const name = typeof title === "string" && title.trim() ? title.trim().slice(0, 200) : deck.title;
    store.insertSession(slug, deck.id, name);
    return reply.code(201).send({ slug });
  });

  app.delete("/api/sessions/:slug", guarded, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    if (!store.session(slug)) return reply.code(404).send({ error: "No such session." });
    if ((request.body as { confirm?: unknown } | null)?.confirm !== slug) {
      return reply.code(400).send({ error: "Type the slug to confirm." });
    }
    store.deleteSession(slug);
    rooms.removed(slug);
    return reply.code(204).send();
  });

  app.get("/api/sessions/:slug/qr.svg", guarded, async (request, reply) =>
    withSession(request, reply, async (session) => {
      const svg = await QRCode.toString(`${siteOrigin(request)}/${session.slug}`, { type: "svg", margin: 1 });
      return reply.type("image/svg+xml").header("Cache-Control", "no-store").send(svg);
    }),
  );

  // Controls

  app.get("/controls/:slug", guarded, async (request, reply) =>
    withSession(request, reply, (_s, deck) => sendDeck(request, reply, deck, "private, no-cache")),
  );

  app.get("/controls/:slug/next", guarded, async (request, reply) =>
    withSession(request, reply, (_s, deck) => sendDeck(request, reply, deck, "private, no-cache")),
  );

  // Viewer. Fixed routes above win over this one.

  app.get("/:slug", async (request, reply) =>
    withSession(request, reply, (_s, deck) => sendDeck(request, reply, deck, "public, no-cache")),
  );

  app.setNotFoundHandler((_request, reply) => notFound(reply));

  return app;
}
