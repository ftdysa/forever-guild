import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Config } from "./config.js";
import { MemberStore } from "./db.js";
import { gameData } from "./game-data.js";
import { authRoutes, SESSION_COOKIE } from "./routes/auth.js";
import { memberRoutes } from "./routes/members.js";

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
    store: MemberStore;
  }
}

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

export function buildApp(config: Config): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" && process.env.LOG !== "off" });
  app.decorate("config", config);
  app.decorate("store", new MemberStore(config.dbPath));
  app.addHook("onClose", async () => app.store.close());

  app.register(fastifyCookie, { secret: config.sessionSecret });
  app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: "/" });

  app.setErrorHandler((err: FastifyError, _req, reply) => {
    if (err.validation || err.statusCode === 400) {
      return reply.code(400).send({ error: "bad request" });
    }
    app.log.error(err);
    return reply.code(500).send({ error: "internal" });
  });

  app.register(
    async (api) => {
      api.get("/game-data", async () => gameData());
      api.register(authRoutes);
      api.register(async (secured) => {
        secured.addHook("onRequest", async (req, reply) => {
          const raw = req.cookies[SESSION_COOKIE];
          if (!raw) return reply.code(401).send({ error: "unauthorized" });
          const { valid } = req.unsignCookie(raw);
          if (!valid) return reply.code(401).send({ error: "unauthorized" });
        });
        secured.register(memberRoutes);
      });
    },
    { prefix: "/api" },
  );

  return app;
}
