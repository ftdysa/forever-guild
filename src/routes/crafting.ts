import type { FastifyPluginCallback } from "fastify";
import { craftersByRecipe } from "../recipe-catalog.js";

// With no catalog stored, a failed first build is retried this long after it failed (otherwise
// the daily timer would be the only retry).
export const FIRST_BUILD_RETRY_MS = 10 * 60_000;

// The crafting directory: the recipe catalog joined to the members who know each recipe.
export const craftingRoutes: FastifyPluginCallback = (app, _opts, done) => {
  app.get("/crafting", async (_req, reply) => {
    const recipes = app.recipes;
    if (!recipes) return reply.code(404).send({ error: "crafting disabled" });
    const catalog = recipes.current();
    if (!catalog) {
      if (!recipes.isBuilding() && recipes.hasFailed() && (recipes.failedFor() ?? 0) >= FIRST_BUILD_RETRY_MS) {
        recipes.checkBuild().catch((err: unknown) => app.log.warn({ err }, "recipe catalog build failed"));
        return { status: "building", catalog: null, crafters: {} };
      }
      const status = recipes.isBuilding() || !recipes.hasFailed() ? "building" : "unavailable";
      return { status, catalog: null, crafters: {} };
    }
    return { status: "ready", catalog, crafters: craftersByRecipe(catalog, app.store.list()) };
  });
  done();
};
