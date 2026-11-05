import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProgress } from "../src/progress-report.js";
import type { Snapshot } from "../src/progress-store.js";

const s = (name: string, day: string, level: number, over: Partial<Snapshot> = {}): Snapshot => ({
  name, day, classId: "warrior", race: "Orc", level, pvpRank: null, honorableKills: null, skills: {}, ...over,
});

test("empty history", () => {
  const r = buildProgress([], [], [], "2026-11-05");
  assert.deepEqual(r.links, {});
  assert.equal(r.trackingSince, null);
  assert.deepEqual(r.series, []);
  assert.deepEqual(r.pvp, []);
  assert.deepEqual(r.firsts.byLevel["60"], { holders: [], atLaunch: [] });
});

test("series keep first, last and both sides of each change, so plateaus stay flat", () => {
  const r = buildProgress(
    [s("Grom", "2026-11-01", 40), s("Grom", "2026-11-02", 40), s("Grom", "2026-11-03", 40), s("Grom", "2026-11-04", 42), s("Grom", "2026-11-05", 42), s("Grom", "2026-11-06", 42)],
    [],
    [{ characterName: "grom", surname: null }],
    "2026-11-06",
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
    "2026-11-05",
  );
  assert.deepEqual(r.series.map((x) => [x.name, x.current]), [["Arg", true], ["Grom", false]]);
  assert.deepEqual(r.pvp, [{
    name: "Grom", class: "warrior", race: "Orc", current: false, rank: 4, highestRank: 5, honorableKills: 450,
    history: [["2026-11-01", 3, 100], ["2026-11-02", 5, 400], ["2026-11-03", 4, 450]],
  }]);
});

test("races seen in snapshots appear in firsts.byRace even when unclaimed", () => {
  assert.deepEqual(Object.keys(buildProgress([s("Zap", "2026-11-01", 5, { race: "Gnome" })], [], [], "2026-11-05").firsts.byRace), ["Gnome"]);
});

test("current members are matched by full name and linked to their armory identity; former members are not", () => {
  const r = buildProgress(
    [s("The Bonelord", "2026-11-01", 30), s("The Antichrist", "2026-11-01", 20), s("The", "2026-11-01", 10)],
    [],
    [{ characterName: "The", surname: "Bonelord" }, { characterName: "Grom", surname: null }],
    "2026-11-05",
  );
  assert.deepEqual(r.series.map((x) => [x.name, x.current]), [["The Bonelord", true], ["The Antichrist", false], ["The", false]]);
  assert.deepEqual(r.links, {
    "the bonelord": { characterName: "The", surname: "Bonelord" },
    grom: { characterName: "Grom", surname: null },
  });
});

const mem = (n: string) => ({ characterName: n, surname: null });
const TODAY = "2026-11-12";

test("standings: level desc, then earliest day at that level, then name; former members excluded", () => {
  const r = buildProgress(
    [
      s("Bee", "2026-11-01", 20), s("Bee", "2026-11-05", 30),
      s("Ann", "2026-11-01", 20), s("Ann", "2026-11-04", 30),
      s("Cat", "2026-11-02", 30),
      s("Dan", "2026-11-02", 30),
      s("Gone", "2026-11-01", 60),
      s("Top", "2026-11-03", 40, { classId: "mage", race: "Human" }),
    ],
    [],
    ["Bee", "Ann", "Cat", "Dan", "Top"].map(mem),
    TODAY,
  );
  assert.deepEqual(r.leaderboard.standings.map((x) => [x.name, x.level, x.reachedOn]), [
    ["Top", 40, "2026-11-03"],
    ["Cat", 30, "2026-11-02"],
    ["Dan", 30, "2026-11-02"],
    ["Ann", 30, "2026-11-04"],
    ["Bee", 30, "2026-11-05"],
  ]);
  assert.deepEqual(r.leaderboard.standings[0], { name: "Top", class: "mage", race: "Human", level: 40, reachedOn: "2026-11-03", gained7d: 0 });
});

test("gained7d: baseline is the latest snapshot on or before today-7, else the earliest", () => {
  const r = buildProgress(
    [
      s("Exact", "2026-11-04", 10), s("Exact", "2026-11-05", 12), s("Exact", "2026-11-12", 15),
      s("Newer", "2026-11-09", 20), s("Newer", "2026-11-12", 23),
      s("Flat", "2026-11-01", 30), s("Flat", "2026-11-12", 30),
      s("Before", "2026-11-01", 5), s("Before", "2026-11-06", 8), s("Before", "2026-11-12", 9),
    ],
    [],
    ["Exact", "Newer", "Flat", "Before"].map(mem),
    TODAY,
  );
  const g = Object.fromEntries(r.leaderboard.standings.map((x) => [x.name, x.gained7d]));
  // today-7 = 2026-11-05: Exact baseline is the 11-05 snapshot (12), Before's is 11-01 (5).
  assert.deepEqual(g, { Exact: 3, Newer: 3, Flat: 0, Before: 4 });
});

test("fastest: excludes zero gains, ties by level then name, caps at 10", () => {
  const names = Array.from({ length: 12 }, (_, i) => `P${String(i).padStart(2, "0")}`);
  const rows = names.flatMap((n, i) => [s(n, "2026-11-01", 10 + i), s(n, TODAY, 12 + i)]);
  rows.push(s("Zero", "2026-11-01", 50), s("Zero", TODAY, 50));
  const r = buildProgress(rows, [], [...names, "Zero"].map(mem), TODAY);
  assert.equal(r.leaderboard.fastest.length, 10);
  assert.ok(r.leaderboard.fastest.every((x) => x.gained7d === 2));
  assert.deepEqual(r.leaderboard.fastest.map((x) => x.name), names.slice().reverse().slice(0, 10));
});

test("mostFirsts counts first holders across every category group, current members only", () => {
  const m = (name: string, kind: "level" | "skill" | "pvp_rank", key: string, classId: string, at: string, race: string | null = "Orc") =>
    ({ name, kind, key, classId, race, reachedAt: at, source: "observed" as const, announced: true });
  const r = buildProgress(
    [s("Ann", "2026-11-01", 60, { classId: "mage" }), s("Bob", "2026-11-01", 60), s("Gone", "2026-11-01", 60)],
    [
      m("Ann", "level", "60", "mage", "2026-11-02"), // byLevel 60, byClassLevel mage 60, byRace Orc
      m("Bob", "level", "60", "warrior", "2026-11-03"), // byClassLevel warrior 60 only
      m("Bob", "level", "10", "warrior", "2026-10-01"), // byLevel 10, byClassLevel warrior 10
      m("Bob", "skill", "mining", "warrior", "2026-11-01"), // bySkill
      m("Bob", "pvp_rank", "1", "warrior", "2026-11-01"), // byPvpRank
      m("Gone", "level", "20", "rogue", "2026-10-01"),
    ],
    [mem("Ann"), mem("Bob")],
    TODAY,
  );
  assert.deepEqual(r.leaderboard.mostFirsts, [
    { name: "Bob", class: "warrior", count: 5 },
    { name: "Ann", class: "mage", count: 3 },
  ]);
});

test("skills: top 3 per profession from latest snapshots, empty professions omitted, former members excluded", () => {
  const r = buildProgress(
    [
      s("A", "2026-11-01", 10, { skills: { mining: 300 } }), s("A", "2026-11-02", 10, { skills: { mining: 100 } }),
      s("B", "2026-11-02", 10, { skills: { mining: 200, herbalism: 50 } }),
      s("C", "2026-11-02", 10, { skills: { mining: 200 } }),
      s("D", "2026-11-02", 10, { skills: { mining: 150 } }),
      s("Gone", "2026-11-02", 10, { skills: { mining: 300, cooking: 300 } }),
    ],
    [],
    ["A", "B", "C", "D"].map(mem),
    TODAY,
  );
  assert.deepEqual(r.leaderboard.skills, {
    mining: [
      { name: "B", class: "warrior", skill: 200 },
      { name: "C", class: "warrior", skill: 200 },
      { name: "D", class: "warrior", skill: 150 },
    ],
    herbalism: [{ name: "B", class: "warrior", skill: 50 }],
  });
});

test("mostFirsts takes name and class from the holder", () => {
  const r = buildProgress(
    // Latest snapshot says priest; the milestone row (the holder) was recorded as a mage named "ann".
    [s("Ann", "2026-11-01", 60, { classId: "priest" })],
    [{ name: "ann", kind: "level", key: "60", classId: "mage", race: "Orc", reachedAt: "2026-11-02", source: "observed", announced: true }],
    [mem("Ann")],
    TODAY,
  );
  assert.deepEqual(r.leaderboard.mostFirsts, [{ name: "ann", class: "mage", count: 3 }]);
});
