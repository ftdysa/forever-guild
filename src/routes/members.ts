import type { FastifyInstance, FastifyPluginCallback } from "fastify";
import { BlizzardError } from "../blizzard.js";
import { altOfError, validateDetails } from "../validate.js";
import type { Member } from "../db.js";
import { audit } from "../audit.js";
import { progressName } from "../progress.js";
import { recipeIndex } from "../recipe-catalog.js";
import { computeSweat, type SweatResult } from "../sweat.js";

// Sweat scores for the whole guild (scores are relative, so always computed over every member).
export function guildSweat(app: FastifyInstance, members: Member[]): Map<number, SweatResult> {
  const catalog = app.recipes?.current() ?? null;
  return computeSweat(members, catalog ? recipeIndex(catalog) : null, Date.now());
}

// A member as the roster shows it: without recipe ids, with the player's sweat.
function present(m: Member, members: Member[], sweat: Map<number, SweatResult>) {
  const r = sweat.get(m.id);
  const main = r && members.find((x) => x.id === r.mainId);
  return {
    ...withoutRecipes(m),
    sweat: r && main ? { ...r, main: progressName(main.characterName, main.surname) } : null,
  };
}

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
    const members = app.store.list();
    const sweat = guildSweat(app, members);
    return members.map((m) => present(m, members, sweat));
  });

  app.put<{ Params: { id: string } }>("/members/:id", async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: "invalid id" });
    const member = app.store.get(id);
    if (!member) return reply.code(404).send({ error: "not found" });
    const v = validateDetails(req.body, member.mainClass);
    if (!v.ok) return reply.code(400).send({ error: "validation failed", details: v.errors });
    const altError = altOfError(id, v.value.altOf, app.store.list());
    if (altError) return reply.code(400).send({ error: "validation failed", details: [altError] });
    const updated = app.store.updateDetails(id, v.value);
    if (!updated) return reply.code(404).send({ error: "not found" });
    audit(req, "member.update", { memberId: id, characterName: updated.characterName });
    const members = app.store.list();
    return present(updated, members, guildSweat(app, members));
  });

  done();
};
