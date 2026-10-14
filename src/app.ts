import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Config } from "./config.js";
import { MemberStore } from "./db.js";
import { gameData } from "./game-data.js";
import { loginRoute, logoutRoute, SESSION_COOKIE } from "./routes/auth.js";
import { memberRoutes } from "./routes/members.js";

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
    store: MemberStore;
  }
}

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

export function buildApp(config: Config): FastifyInstance {
  const app = Fastify({
    logger: process.env.NODE_ENV !== "test" && process.env.LOG !== "off",
    trustProxy: process.env.TRUST_PROXY === "true",
  });
  app.decorate("config", config);
  app.decorate("store", new MemberStore(config.dbPath));
  app.addHook("onClose", async () => app.store.close());

  app.register(fastifyCookie, { secret: config.sessionSecret });
  app.register(fastifyRateLimit, { global: false });
  app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: "/" });

  app.setErrorHandler((err: FastifyError, _req, reply) => {
    const status = err.validation ? 400 : err.statusCode;
    if (status !== undefined && status >= 400 && status <= 499) {
      const msg =
        status === 400 ? "bad request" : status === 413 ? "payload too large" : status === 415 ? "unsupported media type" : "request error";
      return reply.code(status).send({ error: msg });
    }
    app.log.error(err);
    return reply.code(500).send({ error: "internal" });
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "not found" }));

  app.register(
    async (api) => {
      api.get("/game-data", async () => gameData());
      api.register(loginRoute);
      api.register(async (secured) => {
        secured.addHook("onRequest", async (req, reply) => {
          const raw = req.cookies[SESSION_COOKIE];
          if (!raw) return reply.code(401).send({ error: "unauthorized" });
          const { valid } = req.unsignCookie(raw);
          if (!valid) return reply.code(401).send({ error: "unauthorized" });
        });
        secured.register(logoutRoute);
        secured.register(memberRoutes);
      });
    },
    { prefix: "/api" },
  );

  return app;
}
