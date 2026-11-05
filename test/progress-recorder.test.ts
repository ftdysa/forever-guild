import { test } from "node:test";
import assert from "node:assert/strict";
import type { CharacterInfo } from "../src/armory.js";
import { openDatabase, type Member, type RosterMember } from "../src/db.js";
import { ProgressRecorder } from "../src/progress.js";
import { ProgressStore } from "../src/progress-store.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 5, 12);

const member = (name: string, level: number, mainClass = "warrior") => ({ characterName: name, surname: null, mainClass, level }) as unknown as Member;
const roster = (name: string, level: number, classId = "warrior"): RosterMember => ({ name, surname: null, slug: null, level, classId, rank: 4 });
const info = (over: Partial<CharacterInfo> = {}) =>
  ({ level: 1, classId: "warrior", race: "Orc", lastLogin: null, professions: null, pvp: null, milestoneAchievements: [], ...over }) as CharacterInfo;

// The level-60 rows; lower thresholds are recorded alongside them.
const sixty = <T extends { key: string }>(ms: T[]) => ms.filter((m) => m.key === "60");

function setup() {
  let t = T0;
  const store = new ProgressStore(openDatabase(":memory:"));
  const posts: [string, string[]][] = [];
  const notifier = { guildFirsts: async (who: { name: string }, claims: string[]) => void posts.push([who.name, claims]) };
  const rec = new ProgressRecorder(store, notifier, () => t);
  return { store, rec, posts, nextDay: () => (t += DAY), now: () => t };
}

test("roster pass snapshots every member's level and class, including low levels", () => {
  const { store, rec } = setup();
  rec.recordRoster([roster("Grom", 59), roster("Tiny", 3, "mage")]);
  assert.deepEqual(store.snapshots().map((s) => [s.name, s.day, s.classId, s.level, s.race]), [
    ["Grom", "2026-11-05", "warrior", 59, null],
    ["Tiny", "2026-11-05", "mage", 3, null],
  ]);
});

test("armory pass adds race, PvP and skills, keeping known values when a field is missing", async () => {
  const { store, rec } = setup();
  rec.recordRoster([roster("Grom", 40)]);
  await rec.recordArmory(member("Grom", 40), info({
    level: 40,
    pvp: { rank: 2, honorableKills: 31 },
    professions: { primary: ["mining"], secondary: [], skills: { mining: { skill: 150, max: 225 } }, recipes: [] } as unknown as CharacterInfo["professions"],
  }));
  await rec.recordArmory(member("Grom", 40), info({ level: 40, race: null }));
  assert.deepEqual(store.get("Grom", "2026-11-05"), {
    name: "Grom", day: "2026-11-05", classId: "warrior", race: "Orc", level: 40, pvpRank: 2, honorableKills: 31, skills: { mining: 150 },
  });
});

test("launch members are backfilled from achievements; nothing is announced", async () => {
  const { store, rec, posts } = setup();
  rec.recordRoster([roster("Grom", 60)]);
  await rec.recordArmory(member("Grom", 60), info({
    level: 60,
    milestoneAchievements: [{ kind: "level", key: "60", classId: "warrior", completedAt: "2026-10-01T00:00:00.000Z" }],
  }));
  assert.deepEqual(sixty(store.milestones()).map((m) => [m.name, m.source, m.reachedAt]), [["Grom", "achievement", "2026-10-01T00:00:00.000Z"]]);
  assert.deepEqual(posts, []);
});

test("a ding observed on a later day is recorded with the login time and announced once", async () => {
  const { store, rec, posts, nextDay, now } = setup();
  rec.recordRoster([roster("Grom", 59)]);
  await rec.recordArmory(member("Grom", 59), info({ level: 59 }));
  nextDay();
  const login = new Date(now() - 3_600_000).toISOString();
  rec.recordRoster([roster("Grom", 60)]);
  await rec.recordArmory(member("Grom", 60), info({ level: 60, lastLogin: login }));
  await rec.recordArmory(member("Grom", 60), info({ level: 60, lastLogin: login }));
  const [m] = sixty(store.milestones());
  assert.deepEqual([m.source, m.reachedAt, m.announced], ["observed", login, true]);
  assert.deepEqual(posts, [["Grom", ["First to reach level 60", "First Warrior to reach level 60", "First Orc to reach level 60"]]]);
});

test("a lower-level ding is observed and announces the overall first only", async () => {
  const { store, rec, posts, nextDay } = setup();
  rec.recordRoster([roster("Grom", 19)]);
  await rec.recordArmory(member("Grom", 19), info({ level: 19 }));
  nextDay();
  rec.recordRoster([roster("Grom", 21)]);
  await rec.recordArmory(member("Grom", 21), info({ level: 21 }));
  const twenty = store.milestonesFor("Grom").find((m) => m.key === "20");
  assert.deepEqual([twenty?.source, twenty?.announced], ["observed", true]);
  assert.deepEqual(posts, [["Grom", ["First to reach level 20"]]]);
});

test("a ding that claims nothing is recorded but not announced", async () => {
  const { store, rec, posts, nextDay } = setup();
  store.addMilestone({ name: "Early", kind: "level", key: "60", classId: "warrior", race: "Orc", reachedAt: "2026-10-01T00:00:00.000Z", source: "achievement" });
  rec.recordRoster([roster("Grom", 59)]);
  nextDay();
  rec.recordRoster([roster("Grom", 60)]);
  await rec.recordArmory(member("Grom", 60), info({ level: 60 }));
  assert.equal(sixty(store.milestonesFor("Grom"))[0].announced, false);
  assert.deepEqual(posts, []);
});

test("newcomers who arrive past a milestone are before_joining", async () => {
  const { store, rec, nextDay } = setup();
  rec.recordRoster([roster("Grom", 20)]);
  nextDay();
  rec.recordRoster([roster("Grom", 20), roster("Vet", 60)]);
  await rec.recordArmory(member("Vet", 60), info({ level: 60 }));
  assert.deepEqual(store.milestonesFor("Vet").map((m) => m.source), Array(6).fill("before_joining"));
});

test("a ding is still observed when the armory refresh only succeeds days after the roster showed level 60", async () => {
  const { store, rec, posts, nextDay, now } = setup();
  rec.recordRoster([roster("Grom", 59)]);
  await rec.recordArmory(member("Grom", 59), info({ level: 59 }));
  nextDay();
  const login = new Date(now() - 3_600_000).toISOString();
  rec.recordRoster([roster("Grom", 60)]); // armory read failed today
  nextDay();
  rec.recordRoster([roster("Grom", 60)]);
  await rec.recordArmory(member("Grom", 60), info({ level: 60, lastLogin: login }));
  const [m] = sixty(store.milestones());
  assert.deepEqual([m.source, m.reachedAt, m.announced], ["observed", login, true]);
  assert.equal(posts.length, 1);
});

test("characters are keyed by full name, so a shared first name keeps separate history", async () => {
  const { store, rec, posts } = setup();
  const named = (surname: string, level: number) => ({ ...roster("The", level, "warlock"), surname });
  rec.recordRoster([named("Bonelord", 60), named("Antichrist", 20)]);
  await rec.recordArmory({ ...member("The", 60, "warlock"), surname: "Bonelord" } as Member, info({ level: 60, race: "Undead" }));
  assert.deepEqual(store.snapshots().map((s) => [s.name, s.level, s.race]), [["The Antichrist", 20, null], ["The Bonelord", 60, "Undead"]]);
  assert.deepEqual(store.milestones().map((m) => [m.name, m.kind, m.key]), ["10", "20", "30", "40", "50", "60"].map((k) => ["The Bonelord", "level", k]));
  assert.deepEqual(posts, []);
});
