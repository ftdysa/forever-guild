import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProgress } from "../src/progress-report.js";
import type { Snapshot } from "../src/progress-store.js";

const s = (name: string, day: string, level: number, over: Partial<Snapshot> = {}): Snapshot => ({
  name, day, classId: "warrior", race: "Orc", level, pvpRank: null, honorableKills: null, skills: {}, ...over,
});

test("empty history", () => {
  const r = buildProgress([], [], []);
  assert.deepEqual(r.links, {});
  assert.equal(r.trackingSince, null);
  assert.deepEqual(r.series, []);
  assert.deepEqual(r.pvp, []);
  assert.deepEqual(r.firsts.overall60, { holders: [], atLaunch: [] });
});

test("series keep first, last and both sides of each change, so plateaus stay flat", () => {
  const r = buildProgress(
    [s("Grom", "2026-11-01", 40), s("Grom", "2026-11-02", 40), s("Grom", "2026-11-03", 40), s("Grom", "2026-11-04", 42), s("Grom", "2026-11-05", 42), s("Grom", "2026-11-06", 42)],
    [],
    [{ characterName: "grom", surname: null }],
  );
  assert.equal(r.trackingSince, "2026-11-01");
  assert.deepEqual(r.series, [{
    name: "Grom", class: "warrior", race: "Orc", current: true,
    levels: [["2026-11-01", 40], ["2026-11-03", 40], ["2026-11-04", 42], ["2026-11-06", 42]],
  }]);
});

test("former members stay, flagged; PvP lists only characters with rank or kills", () => {
  const r = buildProgress(
    [
      s("Arg", "2026-11-01", 30, { pvpRank: 0, honorableKills: 0 }),
      s("Grom", "2026-11-01", 50, { pvpRank: 3, honorableKills: 100 }),
      s("Grom", "2026-11-02", 50, { pvpRank: 5, honorableKills: 400 }),
      s("Grom", "2026-11-03", 50, { pvpRank: 4, honorableKills: 450 }),
    ],
    [],
    [{ characterName: "arg", surname: null }],
  );
  assert.deepEqual(r.series.map((x) => [x.name, x.current]), [["Arg", true], ["Grom", false]]);
  assert.deepEqual(r.pvp, [{
    name: "Grom", class: "warrior", race: "Orc", current: false, rank: 4, highestRank: 5, honorableKills: 450,
    history: [["2026-11-01", 3, 100], ["2026-11-02", 5, 400], ["2026-11-03", 4, 450]],
  }]);
});

test("races seen in snapshots appear in firsts.byRace even when unclaimed", () => {
  assert.deepEqual(Object.keys(buildProgress([s("Zap", "2026-11-01", 5, { race: "Gnome" })], [], []).firsts.byRace), ["Gnome"]);
});

test("current members are matched by full name and linked to their armory identity; former members are not", () => {
  const r = buildProgress(
    [s("The Bonelord", "2026-11-01", 30), s("The Antichrist", "2026-11-01", 20), s("The", "2026-11-01", 10)],
    [],
    [{ characterName: "The", surname: "Bonelord" }, { characterName: "Grom", surname: null }],
  );
  assert.deepEqual(r.series.map((x) => [x.name, x.current]), [["The Bonelord", true], ["The Antichrist", false], ["The", false]]);
  assert.deepEqual(r.links, {
    "the bonelord": { characterName: "The", surname: "Bonelord" },
    grom: { characterName: "Grom", surname: null },
  });
});
