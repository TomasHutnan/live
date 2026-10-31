import type Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";
import { BasicAuth } from "./auth.ts";
import type { Config } from "./config.ts";
import { allowsUnsafeRequest } from "./origin.ts";

export async function buildApp(config: Config, db: Database.Database): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, trustProxy: config.trustProxy });
  const auth = new BasicAuth(config.adminUser, config.adminPasswordHash);

  app.addHook("onRequest", async (request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    if (request.method === "GET" || request.method === "HEAD") return;
    if (!allowsUnsafeRequest(request.headers.origin, request.host, config)) {
      await reply.code(403).type("text/plain; charset=utf-8").send("Cross-site request refused.\n");
    }
  });

  app.get("/healthz", async () => {
    db.prepare("SELECT 1").get();
    return { ok: true };
  });

  app.get("/", async (_request, reply) => reply.redirect("/dashboard"));
  app.get("/dashboard", { preHandler: auth.guard }, async () => "dashboard");

  return app;
}
