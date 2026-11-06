import { test } from "node:test";
import assert from "node:assert/strict";
import type { Member, MemberArmory } from "../src/db.js";
import { activityMultiplier, computeSweat, sweatLeaderboard, tierFor } from "../src/sweat.js";

const NOW = Date.UTC(2026, 10, 6);
const DAY = 86_400_000;
const today = new Date(NOW).toISOString();

// A member read from the armory with nothing known but their level (and a login today).
function member(id: number, over: Partial<Member> = {}, armory: Partial<MemberArmory> | null = {}): Member {
  return {
    id,
    characterName: `C${id}`,
    surname: null,
    mainClass: "warrior",
    mainSpec: null,
    level: 10,
    guildRank: 0,
    backupClass: null,
    backupSpec: null,
    altOf: null,
    levelingPref: null,
    notes: "",
    primaryProfessions: [],
    secondaryProfessions: [],
    createdAt: "",
    updatedAt: "",
    armory:
      armory === null
        ? null
        : {
            race: null, gender: null, faction: null, title: null, itemLevel: null, lastLogin: today,
            achievementPoints: null, legacy: null, skills: {}, recipes: [], pvp: null, sweatStats: null,
            ...armory,
          },
    ...over,
  };
}

const score = (members: Member[], id: number) => computeSweat(members, null, NOW).get(id)?.score;

test("missing metrics are dropped and the rest rescaled to 100", () => {
  // Known: level (20, top of a guild of one) and profession skill (12, none learned) → 20/32.
  const r = computeSweat([member(1)], null, NOW).get(1);
  assert.equal(r?.score, 63);
  assert.equal(r?.tier, "drenched");
  assert.equal(r?.mainId, 1);
  assert.deepEqual(r?.breakdown, { leveling: 62.5, gear: 0, professions: 0, dungeons: 0, pvp: 0, reputation: 0, legacy: 0, questing: 0 });
});

test("percentiles are inclusive across the guild", () => {
  const guild = [member(1, { level: 10 }), member(2, { level: 20 }), member(3, { level: 20 })];
  // Level 10 is at or above 1 of 3: 20 × 1/3 of 32 known points.
  assert.equal(score(guild, 1), 21);
  assert.equal(score(guild, 2), 63);
  assert.equal(score(guild, 3), 63);
});

test("a zero value scores 0 even when everyone else is also low", () => {
  const guild = [member(1, {}, { legacy: { earned: 0, total: 65 } }), member(2, {}, { legacy: { earned: 2, total: 65 } })];
  // Known: level 20 + skill 12 + legacy 10 = 42.
  assert.equal(score(guild, 1), 48); // 20/42
  assert.equal(score(guild, 2), 71); // 30/42
});

test("every metric is read and weighted", () => {
  const all = member(1, { level: 30, primaryProfessions: ["mining"] }, {
    itemLevel: 20,
    skills: { mining: { skill: 300, max: 300 } },
    pvp: { rank: 7, honorableKills: 5 },
    legacy: { earned: 3, total: 65 },
    sweatStats: { dungeonsEntered: 3, dungeonBossKills: 2, raidBossKills: 0, questsCompleted: 50, exalted: 0, factionsEncountered: 10 },
  });
  // Recipes unknown (no catalog) → 92 known points; 80.4 earned:
  // 20 + 10 + 12×0.2 + 7 + 8 + 6 + 4×0.5 + 5 + 10 + 10.
  const r = computeSweat([all], null, NOW).get(1);
  assert.equal(r?.score, 87);
  assert.equal(r?.tier, "swamp-ass");
  assert.equal(r?.breakdown.dungeons, 16.3);
  assert.equal(r?.breakdown.pvp, 8.7);
  assert.equal(r?.breakdown.professions, 2.6);
});

test("recipes count against the catalog total of each learned primary", () => {
  const recipes = { totals: { alchemy: 4 }, professionOf: new Map([[1, "alchemy"], [2, "alchemy"], [9, "cooking"]]) };
  // Herbalism has no catalog entry, so only alchemy counts: 2 of 4 known.
  const m = member(1, { primaryProfessions: ["alchemy", "herbalism"] }, { recipes: [1, 2, 9] });
  // Known: level 20 + skill 12 + recipes 8 = 40; earned 20 + 0 + 4.
  assert.equal(computeSweat([m], recipes, NOW).get(1)?.score, 60);
});

test("alts add a quarter of their values to their main, capped at 1", () => {
  const main = member(1, { level: 20, primaryProfessions: ["mining"] }, { skills: { mining: { skill: 150, max: 225 } } });
  const alt = member(2, { level: 10, altOf: 1, primaryProfessions: ["herbalism"] }, { skills: { herbalism: { skill: 300, max: 300 } } });
  const other = member(3, { level: 20 });
  const results = computeSweat([main, alt, other], null, NOW);
  // Skill: best 0.2 (alt) + 0.25 × 0.1 (main) = 0.225. Level: 1 + 0.25 × 1/3, capped at 1.
  assert.equal(results.get(1)?.score, 71);
  assert.equal(results.get(1)?.breakdown.leveling, 62.5);
  assert.equal(results.get(1)?.breakdown.professions, 8.4);
  assert.deepEqual(results.get(2), results.get(1));
  assert.equal(results.get(2)?.mainId, 1);
  assert.equal(results.get(3)?.score, 63);
});

test("legacy is account-wide: the best character counts, alts add nothing", () => {
  const guild = [
    member(1, {}, { legacy: { earned: 2, total: 65 } }),
    member(2, { altOf: 1 }, { legacy: { earned: 2, total: 65 } }),
    member(3, {}, { legacy: { earned: 4, total: 65 } }),
  ];
  // Legacy 2 is at or above 2 of 3 → 2/3 of 10, with no alt bonus: (20 + 6.67) / 42.
  assert.equal(score(guild, 1), 63);
  assert.equal(score(guild, 3), 71);
});

test("members never read from the armory have no score unless their main does", () => {
  assert.equal(computeSweat([member(1, {}, null)], null, NOW).size, 0);
  const results = computeSweat([member(1), member(2, { altOf: 1 }, null)], null, NOW);
  assert.equal(results.get(2)?.score, 63);
  assert.equal(results.get(2)?.mainId, 1);
});

test("the activity multiplier follows the player's most recent login", () => {
  const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
  assert.equal(activityMultiplier(null, NOW), 1);
  assert.equal(activityMultiplier(ago(3), NOW), 1);
  assert.equal(activityMultiplier(ago(3.5), NOW), 0.9);
  assert.equal(activityMultiplier(ago(7), NOW), 0.9);
  assert.equal(activityMultiplier(ago(8), NOW), 0.75);
  assert.equal(activityMultiplier(ago(14), NOW), 0.75);
  assert.equal(activityMultiplier(ago(20), NOW), 0.5);
  assert.equal(activityMultiplier(ago(30), NOW), 0.5);
  assert.equal(activityMultiplier(ago(31), NOW), 0.25);
  // 62.5 × 0.75
  assert.equal(score([member(1, {}, { lastLogin: ago(10) })], 1), 47);
  // An alt played today keeps the player fresh.
  assert.equal(score([member(1, {}, { lastLogin: ago(40) }), member(2, { altOf: 1 }, null), member(3, { altOf: 1 })], 1), 63);
});

test("tiers start at their minimum score", () => {
  const cases: [number, string][] = [
    [0, "bone-dry"], [14, "bone-dry"], [15, "glistening"], [34, "glistening"], [35, "damp"], [54, "damp"],
    [55, "drenched"], [71, "drenched"], [72, "swamp-ass"], [87, "swamp-ass"], [88, "turbo-sweat"], [100, "turbo-sweat"],
  ];
  for (const [s, tier] of cases) assert.equal(tierFor(s), tier, String(s));
});

test("the sweat leaderboard ranks players by score and lists their alts", () => {
  const guild = [
    member(1, { characterName: "Thrall", surname: "Durotan", mainClass: "shaman", level: 20 }),
    member(2, { characterName: "Rexxar", altOf: 1, mainClass: "hunter" }),
    member(3, { characterName: "Jaina", mainClass: "mage" }),
  ];
  assert.deepEqual(sweatLeaderboard(guild, computeSweat(guild, null, NOW)), [
    { name: "Thrall Durotan", class: "shaman", score: 63, tier: "drenched", alts: ["Rexxar"] },
    { name: "Jaina", class: "mage", score: 42, tier: "damp", alts: [] },
  ]);
});

test("a dangling altOf and an alt of an alt each count as their own main", () => {
  // Can happen after a rollback: the main row is gone, or the main was itself turned into an alt.
  const dangling = computeSweat([member(1, { altOf: 99 })], null, NOW);
  assert.equal(dangling.get(1)?.mainId, 1);
  const chained = computeSweat([member(1), member(2, { altOf: 1 }), member(3, { altOf: 2 })], null, NOW);
  assert.equal(chained.get(3)?.mainId, 3);
});
