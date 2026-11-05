import type { FastifyPluginCallback } from "fastify";
import { BlizzardError } from "../blizzard.js";
import { validateDetails } from "../validate.js";
import type { Member } from "../db.js";
import { audit } from "../audit.js";

// The list needs no recipe ids (hundreds per member); the crafting route reads them from the store.
function withoutRecipes(m: Member): Member {
  if (!m.armory) return m;
  const armory: Partial<NonNullable<Member["armory"]>> = { ...m.armory };
  delete armory.recipes;
  return { ...m, armory: armory as Member["armory"] };
}

function parseId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  return Number(raw);
}

// Members come from the guild roster; the site only edits their details.
export const memberRoutes: FastifyPluginCallback = (app, _opts, done) => {
  app.get("/members", async () => {
    try {
      await app.guildSync?.sync();
    } catch (err) {
      if (!(err instanceof BlizzardError)) throw err;
      // Serve the last synced roster rather than failing the page.
      app.log.warn({ err: err.message }, "guild sync failed");
    }
    return app.store.list().map(withoutRecipes);
  });

  app.put<{ Params: { id: string } }>("/members/:id", async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: "invalid id" });
    const member = app.store.get(id);
    if (!member) return reply.code(404).send({ error: "not found" });
    const v = validateDetails(req.body, member.mainClass);
    if (!v.ok) return reply.code(400).send({ error: "validation failed", details: v.errors });
    const updated = app.store.updateDetails(id, v.value);
    if (!updated) return reply.code(404).send({ error: "not found" });
    audit(req, "member.update", { memberId: id, characterName: updated.characterName });
    return withoutRecipes(updated);
  });

  done();
};
