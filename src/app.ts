import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyHelmet from "@fastify/helmet";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Config } from "./config.js";
import { MemberStore, openDatabase } from "./db.js";
import { gameData } from "./game-data.js";
import { SessionStore } from "./sessions.js";
import { loginRoute, logoutRoute, readSessionToken } from "./routes/auth.js";
import { memberRoutes } from "./routes/members.js";

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
    store: MemberStore;
    sessions: SessionStore;
    clientIp: (req: FastifyRequest) => string;
  }
}

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

export function buildApp(config: Config): FastifyInstance {
  const app = Fastify({
    logger: process.env.NODE_ENV !== "test" && process.env.LOG !== "off",
    // Trust only the one proxy in front of us. `true` would trust every X-Forwarded-For
    // entry, letting clients pick their own req.ip and dodge the login rate limit.
    // (Fastify's types omit the numeric hop count, hence the equivalent trust function.)
    trustProxy: config.trustProxy ? (_addr: string, hop: number) => hop === 0 : false,
  });
  app.decorate("config", config);
  const db = openDatabase(config.dbPath);
  app.decorate("store", new MemberStore(db));
  app.decorate("sessions", new SessionStore(db, config.guildPassphrase, config.sessionSecret));
  app.decorate("clientIp", (req: FastifyRequest) => {
    const fromHeader = config.clientIpHeader ? req.headers[config.clientIpHeader] : undefined;
    return typeof fromHeader === "string" && fromHeader !== "" ? fromHeader : req.ip;
  });
  app.addHook("onClose", async () => db.close());

  app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "https://fonts.googleapis.com"],
        fontSrc: ["https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: config.cookieSecure ? [] : null,
      },
    },
  });
  app.register(fastifyCookie, { secret: config.sessionSecret });
  app.register(fastifyRateLimit, { global: false, keyGenerator: (req) => app.clientIp(req) });
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
          const token = readSessionToken(req);
          if (!token || !app.sessions.isValid(token)) return reply.code(401).send({ error: "unauthorized" });
        });
        secured.register(logoutRoute);
        secured.register(memberRoutes);
      });
    },
    { prefix: "/api" },
  );

  return app;
}
