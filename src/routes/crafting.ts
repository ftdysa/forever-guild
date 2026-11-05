import type { FastifyPluginCallback } from "fastify";
import { craftersByRecipe } from "../recipe-catalog.js";

// The crafting directory: the recipe catalog joined to the members who know each recipe.
export const craftingRoutes: FastifyPluginCallback = (app, _opts, done) => {
  app.get("/crafting", async (_req, reply) => {
    if (!app.recipes) return reply.code(404).send({ error: "crafting disabled" });
    const catalog = app.recipes.current();
    if (!catalog) {
      const status = app.recipes.isBuilding() || !app.recipes.hasFailed() ? "building" : "unavailable";
      return { status, catalog: null, crafters: {} };
    }
    return { status: "ready", catalog, crafters: craftersByRecipe(catalog, app.store.list()) };
  });
  done();
};
