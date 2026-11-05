import { test } from "node:test";
import assert from "node:assert/strict";
import { CLASSES, PROFESSIONS } from "../src/game-data.js";
import { daysBetween, firstsGroups, levelRace, linePath, pvpRows, rankTitle, spreadLabels, TOP } from "../public/progress.js";

const line = (name: string, cls: string, levels: [string, number][], current = true) => ({ name, class: cls, race: "Orc", current, levels });

test("levelRace ranks by level, then who got there first, then name; the top 10 lead", () => {
  const series = [
    line("Late", "warrior", [["2026-11-01", 50], ["2026-11-04", 60]]),
    line("Early", "mage", [["2026-11-01", 50], ["2026-11-02", 60]]),
    line("Alpha", "mage", [["2026-11-01", 40]]),
    ...Array.from({ length: TOP }, (_, i) => line(`Low${i}`, "rogue", [["2026-11-01", 10]])),
  ];
  const r = levelRace(series, { classes: new Set(), today: "2026-11-06" });
  assert.equal(r.start, "2026-11-01");
  assert.equal(r.end, "2026-11-06");
  assert.deepEqual(r.lines.slice(0, 3).map((l) => l.name), ["Early", "Late", "Alpha"]);
  assert.equal(r.lines.filter((l) => l.leader).length, TOP);
  assert.equal(r.lines.at(-1)?.leader, false);
});

test("levelRace filters by class and re-ranks within the filter", () => {
  const series = [line("A", "mage", [["2026-11-01", 30]]), line("B", "rogue", [["2026-11-01", 40]])];
  const r = levelRace(series, { classes: new Set(["mage"]), today: "2026-11-01" });
  assert.deepEqual(r.lines.map((l) => [l.name, l.leader]), [["A", true]]);
  assert.deepEqual(levelRace([], { classes: new Set(), today: "2026-11-01" }), { start: "2026-11-01", end: "2026-11-01", lines: [] });
});

test("linePath scales days and levels and extends the last level to today", () => {
  assert.equal(daysBetween("2026-11-01", "2026-11-11"), 10);
  const geo = { start: "2026-11-01", end: "2026-11-11", width: 100, height: 59, min: 1, max: 60 };
  assert.equal(linePath([["2026-11-01", 1], ["2026-11-06", 60]], geo), "M0,59L50,0L100,0");
  // a single day still spans the width
  assert.equal(linePath([["2026-11-01", 1]], { ...geo, end: "2026-11-01" }), "M0,59");
});

test("spreadLabels pushes overlapping labels apart and keeps input order", () => {
  // sorted: 10, 11→22, 12→34, 50; returned in input order
  assert.deepEqual(spreadLabels([10, 12, 50, 11], 12), [10, 34, 50, 22]);
});

test("rankTitle uses the faction's title, or the number when the race is unknown", () => {
  assert.equal(rankTitle(14, "Orc"), "High Warlord");
  assert.equal(rankTitle(14, "Night Elf"), "Grand Marshal");
  assert.equal(rankTitle(6, "Undead"), "Stone Guard");
  assert.equal(rankTitle(6, null), "Rank 6");
  assert.equal(rankTitle(0, "Orc"), "None");
});

test("firstsGroups orders level 60, classes, races, professions and PvP ranks", () => {
  const empty = { holders: [], atLaunch: [] };
  const firsts = {
    byLevel: { "60": empty },
    byClassLevel: Object.fromEntries(CLASSES.map((c) => [c.id, { "60": empty }])),
    byRace: { Orc: empty, Gnome: empty },
    bySkill: Object.fromEntries(PROFESSIONS.map((p) => [p.id, empty])),
    byPvpRank: Object.fromEntries(Array.from({ length: 14 }, (_, i) => [String(i + 1), empty])),
  };
  const groups = firstsGroups(firsts, { classes: CLASSES, professions: PROFESSIONS });
  assert.deepEqual(groups.map((g) => [g.heading, g.cards.length]), [
    ["Level 60", 1], ["Classes", CLASSES.length], ["Races", 2], ["Professions", PROFESSIONS.length], ["PvP ranks", 14],
  ]);
  assert.equal(groups[0].cards[0].title, "First to 60");
  assert.equal(groups[1].cards[0].title, "Warrior");
  assert.deepEqual(groups[2].cards.map((c) => c.title), ["Gnome", "Orc"]);
  assert.equal(groups[3].cards[0].title, "Alchemy 300");
  assert.deepEqual([groups[4].cards[6].title, groups[4].cards[6].rank], ["Rank 7", 7]);
});

test("pvpRows sorts by the chosen column, ties by name", () => {
  const rows = [
    { name: "b", rank: 5, highestRank: 7, honorableKills: 10 },
    { name: "a", rank: 5, highestRank: 6, honorableKills: 30 },
    { name: "c", rank: 9, highestRank: 9, honorableKills: 20 },
  ];
  assert.deepEqual(pvpRows(rows, { key: "rank", dir: -1 }).map((r) => r.name), ["c", "a", "b"]);
  assert.deepEqual(pvpRows(rows, { key: "hk", dir: 1 }).map((r) => r.name), ["b", "c", "a"]);
  assert.deepEqual(pvpRows(rows, { key: "name", dir: 1 }).map((r) => r.name), ["a", "b", "c"]);
});
