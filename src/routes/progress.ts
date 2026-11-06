import type { FastifyPluginCallback } from "fastify";
import { buildProgress } from "../progress-report.js";
import { utcDay } from "../progress-store.js";
import { sweatLeaderboard } from "../sweat.js";
import { guildSweat } from "./members.js";

// Level race, guild firsts and PvP history. Reads SQLite only; the guild sync fills it.
export const progressRoutes: FastifyPluginCallback = (app, _opts, done) => {
  app.get("/progress", async () => {
    const members = app.store.list();
    const sweat = sweatLeaderboard(members, guildSweat(app, members));
    return buildProgress(app.progress.snapshots(), app.progress.milestones(), members, utcDay(Date.now()), sweat);
  });
  done();
};
