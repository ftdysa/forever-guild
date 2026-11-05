import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from "fastify";
import fastifyCompress from "@fastify/compress";
import fastifyCookie from "@fastify/cookie";
import fastifyHelmet from "@fastify/helmet";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Config } from "./config.js";
import { ArmoryCache, MemberStore, openDatabase } from "./db.js";
import { ArmoryService, ROSTER_TTL_MS } from "./armory.js";
import { BlizzardClient, type FetchFn } from "./blizzard.js";
import { DiscordNotifier } from "./discord.js";
import { GuildSync } from "./guild-sync.js";
import { gameData } from "./game-data.js";
import { SessionStore } from "./sessions.js";
import { loginRoute, logoutRoute, readSessionToken } from "./routes/auth.js";
import { memberRoutes } from "./routes/members.js";
import { armoryRoutes } from "./routes/armory.js";
import { RecipeCatalog } from "./recipe-catalog.js";
import { craftingRoutes } from "./routes/crafting.js";

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
    store: MemberStore;
    armory: ArmoryService | null;
    notifier: DiscordNotifier | null;
    guildSync: GuildSync | null;
    recipes: RecipeCatalog | null;
    sessions: SessionStore;
    clientIp: (req: FastifyRequest) => string;
  }
}

const RECIPE_CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

export interface AppDeps {
  // Replaces global fetch for Blizzard calls (tests).
  blizzardFetch?: FetchFn;
  blizzardSleep?: (ms: number) => Promise<void>;
  // Replaces global fetch for Discord webhook calls (tests).
  discordFetch?: FetchFn;
  // Background guild sync interval; 0 disables the timer (tests).
  syncEveryMs?: number;
  // Daily recipe-catalog build check interval; 0 disables the timer (tests).
  recipeCheckEveryMs?: number;
}

export function buildApp(config: Config, deps: AppDeps = {}): FastifyInstance {
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
  const bz = config.blizzard;
  const client = bz ? new BlizzardClient(bz, deps.blizzardFetch, undefined, deps.blizzardSleep) : null;
  const armory = bz && client ? new ArmoryService(client, new ArmoryCache(db), bz) : null;
  app.decorate("armory", armory);
  const notifier = config.discord ? new DiscordNotifier(config.discord, app.log, deps.discordFetch) : null;
  app.decorate("notifier", notifier);
  const guildSync = armory ? new GuildSync(armory, app.store, notifier, app.log) : null;
  app.decorate("guildSync", guildSync);
  // The crafting directory exists only on Forever (its static data has the recipe catalog we read).
  const recipes = client && bz?.namespace === "forever" ? new RecipeCatalog(client, new ArmoryCache(db), bz.region) : null;
  app.decorate("recipes", recipes);
  app.decorate("sessions", new SessionStore(db, config.guildPassphrase, config.sessionSecret));
  app.decorate("clientIp", (req: FastifyRequest) => {
    const fromHeader = config.clientIpHeader ? req.headers[config.clientIpHeader] : undefined;
    return typeof fromHeader === "string" && fromHeader !== "" ? fromHeader : req.ip;
  });
  // Page loads sync too; the timer catches joins and level-ups while nobody is looking. It runs as
  // often as the roster cache expires, so each tick can see a fresh roster.
  let syncTimer: NodeJS.Timeout | undefined;
  if (guildSync && deps.syncEveryMs !== 0) {
    syncTimer = setInterval(() => {
      guildSync.sync().catch((err: unknown) => app.log.warn({ err }, "scheduled guild sync failed"));
    }, deps.syncEveryMs ?? ROSTER_TTL_MS);
    syncTimer.unref();
  }
  // The recipe catalog is checked at startup (built if missing) and daily for a new game build.
  const checkRecipes = () => {
    recipes?.checkBuild().catch((err: unknown) => app.log.warn({ err }, "recipe catalog build failed"));
  };
  let recipeTimer: NodeJS.Timeout | undefined;
  if (recipes) {
    app.addHook("onReady", async () => checkRecipes());
    if (deps.recipeCheckEveryMs !== 0) {
      recipeTimer = setInterval(checkRecipes, deps.recipeCheckEveryMs ?? RECIPE_CHECK_EVERY_MS);
      recipeTimer.unref();
    }
  }
  app.addHook("onClose", async () => {
    clearInterval(syncTimer);
    clearInterval(recipeTimer);
    await guildSync?.idle();
    await recipes?.idle();
    db.close();
  });

  app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "https://fonts.googleapis.com"],
        fontSrc: ["https://fonts.gstatic.com"],
        // Character avatars come from Blizzard's render CDN.
        imgSrc: ["'self'", "data:", "https://render.worldofwarcraft.com"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: config.cookieSecure ? [] : null,
      },
    },
  });
  // The recipe catalog is ~758 KB of JSON; compression brings it to ~78 KB.
  app.register(fastifyCompress, { global: true, threshold: 1024 });
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
        secured.register(armoryRoutes);
        secured.register(craftingRoutes);
      });
    },
    { prefix: "/api" },
  );

  return app;
}
