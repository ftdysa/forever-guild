import type { FastifyPluginCallback } from "fastify";
import { buildProgress } from "../progress-report.js";

// Level race, guild firsts and PvP history. Reads SQLite only; the guild sync fills it.
export const progressRoutes: FastifyPluginCallback = (app, _opts, done) => {
  app.get("/progress", async () =>
    buildProgress(app.progress.snapshots(), app.progress.milestones(), app.store.list()),
  );
  done();
};
