import type { FastifyPluginCallback, FastifyReply } from "fastify";
import { BlizzardError } from "../blizzard.js";
import { NAME_RE } from "../validate.js";

// Wowhead keeps Classic Era and Forever items under their own prefix; everything else resolves on the main site.
const WOWHEAD_PREFIX: Record<string, string> = { classic1x: "classic/", forever: "forever/" };
const wowheadItemUrl = (namespace: string) => `https://www.wowhead.com/${WOWHEAD_PREFIX[namespace] ?? ""}item=`;

export const armoryRoutes: FastifyPluginCallback = (app, _opts, done) => {
  function upstreamFailed(reply: FastifyReply, err: unknown) {
    if (!(err instanceof BlizzardError)) throw err;
    app.log.warn({ err: err.message }, "armory upstream failure");
    return reply.code(502).send({ error: "armory unavailable" });
  }

  app.get("/armory/status", async () => {
    if (!app.armory) return { enabled: false };
    const { region, namespace, realm, guild, ranks } = app.armory.settings;
    return { enabled: true, region, namespace, realm: realm ?? null, guild, ranks: ranks ?? [], wowheadItemUrl: wowheadItemUrl(namespace) };
  });

  // Cache misses fan out to six Blizzard calls plus uncached item icons (and a roster call on Forever),
  // so cap how fast one client can trigger them.
  app.get<{ Params: { name: string } }>(
    "/armory/character/:name",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req, reply) => {
      if (!app.armory) return reply.code(404).send({ error: "armory disabled" });
      const { name } = req.params;
      if (!NAME_RE.test(name)) return reply.code(400).send({ error: "invalid character name" });
      try {
        const character = await app.armory.character(name);
        if (!character) return reply.code(404).send({ error: "character not found" });
        return character;
      } catch (err) {
        return upstreamFailed(reply, err);
      }
    },
  );

  done();
};
