import { test } from "node:test";
import assert from "node:assert/strict";
import type { CharacterInfo } from "../src/armory.js";
import { openDatabase, type Member, type RosterMember } from "../src/db.js";
import { ProgressRecorder } from "../src/progress.js";
import { computeFirsts } from "../src/milestones.js";
import { ProgressStore, utcDay } from "../src/progress-store.js";

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

test("deploy over pre-milestone history: old crossings are dated from snapshots, not the login, and stay silent", async () => {
  const { store, rec, posts, now } = setup();
  const day = (d: number) => `2026-11-0${d}`;
  const levels = (d: number, ann: number, bob: number) =>
    store.upsertSnapshots(day(d), [{ name: "Ann", patch: { classId: "warrior", level: ann } }, { name: "Bob", patch: { classId: "warrior", level: bob } }]);
  // Snapshots written before level milestones 10-50 existed: Ann 8 -> 12 -> 25, Bob 18 -> 22 -> 31.
  levels(1, 8, 18);
  levels(2, 12, 22);
  levels(4, 25, 31);
  assert.equal(utcDay(now()), "2026-11-05");
  // First sync after deploy; Bob logged in later, so he is processed first.
  rec.recordRoster([roster("Ann", 25), roster("Bob", 31)]);
  await rec.recordArmory(member("Bob", 31), info({ level: 31, lastLogin: "2026-11-05T10:00:00.000Z" }));
  await rec.recordArmory(member("Ann", 25), info({ level: 25, lastLogin: "2026-11-05T09:00:00.000Z" }));

  const rows = store.milestones().filter((m) => m.source === "observed").map((m) => [m.name, m.key, m.reachedAt, m.announced]);
  assert.deepEqual(rows, [
    ["Ann", "10", "2026-11-02T00:00:00.000Z", false],
    ["Ann", "20", "2026-11-04T00:00:00.000Z", false],
    ["Bob", "20", "2026-11-02T00:00:00.000Z", false],
    ["Bob", "30", "2026-11-04T00:00:00.000Z", true],
  ]);
  assert.equal(computeFirsts(store.milestones()).byLevel["20"].holders[0].name, "Bob");
  // Only the crossing seen within the last two days is announced; nothing older, nothing twice.
  assert.deepEqual(posts, [["Bob", ["First to reach level 30"]]]);
});

test("a fresh crossing is dated by last login and announced", async () => {
  const { store, rec, posts, nextDay } = setup();
  rec.recordRoster([roster("Grom", 29)]);
  await rec.recordArmory(member("Grom", 29), info({ level: 29 }));
  nextDay();
  rec.recordRoster([roster("Grom", 30)]);
  await rec.recordArmory(member("Grom", 30), info({ level: 30, lastLogin: "2026-11-06T08:00:00.000Z" }));
  const thirty = store.milestonesFor("Grom").find((m) => m.key === "30");
  assert.deepEqual([thirty?.source, thirty?.reachedAt, thirty?.announced], ["observed", "2026-11-06T08:00:00.000Z", true]);
  assert.deepEqual(posts, [["Grom", ["First to reach level 30"]]]);
});

test("a category already announced is not announced again when a later-processed member sorts ahead", async () => {
  const { store, rec, posts, nextDay } = setup();
  rec.recordRoster([roster("Ann", 19), roster("Bob", 19)]);
  await rec.recordArmory(member("Ann", 19), info({ level: 19 }));
  await rec.recordArmory(member("Bob", 19), info({ level: 19 }));
  nextDay();
  rec.recordRoster([roster("Ann", 20), roster("Bob", 20)]);
  await rec.recordArmory(member("Ann", 20), info({ level: 20, lastLogin: "2026-11-06T10:00:00.000Z" }));
  await rec.recordArmory(member("Bob", 20), info({ level: 20, lastLogin: "2026-11-06T09:00:00.000Z" }));
  assert.equal(computeFirsts(store.milestones()).byLevel["20"].holders[0].name, "Bob");
  assert.deepEqual(posts, [["Ann", ["First to reach level 20"]]]);
});

const crafts = (skills: Record<string, number>) =>
  ({ primary: Object.keys(skills), secondary: [], skills: Object.fromEntries(Object.entries(skills).map(([p, s]) => [p, { skill: s, max: 300 }])), recipes: [] }) as unknown as CharacterInfo["professions"];
const skillRows = (ms: { kind: string; key: string; source: string; reachedAt: string | null; announced: boolean }[]) =>
  ms.filter((m) => m.kind === "skill").map((m) => [m.key, m.source, m.reachedAt, m.announced]);

test("a profession tier crossed since an earlier day is dated by last login and announced", async () => {
  const { store, rec, posts, nextDay } = setup();
  rec.recordRoster([roster("Grom", 5)]);
  await rec.recordArmory(member("Grom", 5), info({ level: 5, professions: crafts({ alchemy: 140 }) }));
  nextDay();
  rec.recordRoster([roster("Grom", 5)]);
  await rec.recordArmory(member("Grom", 5), info({ level: 5, professions: crafts({ alchemy: 160 }), lastLogin: "2026-11-06T08:00:00.000Z" }));
  assert.deepEqual(skillRows(store.milestonesFor("Grom")), [
    ["alchemy:150", "observed", "2026-11-06T08:00:00.000Z", true],
    ["alchemy:75", "before_tracking", null, false],
  ]);
  assert.deepEqual(posts, [["Grom", ["First to reach 150 Alchemy"]]]);
});

test("deploy over skill history: old tier crossings are dated from snapshots and only fresh ones are announced", async () => {
  const { store, rec, posts } = setup();
  // Armory snapshots written before the 75/150/225 tiers existed: Ann's alchemy 60 -> 160 -> 230.
  const at = (day: string, alchemy: number) => store.upsertSnapshot("Ann", day, { classId: "warrior", level: 5, race: "Orc", skills: { alchemy } });
  at("2026-11-01", 60);
  at("2026-11-02", 160);
  at("2026-11-04", 230);
  rec.recordRoster([roster("Ann", 5)]);
  await rec.recordArmory(member("Ann", 5), info({ level: 5, professions: crafts({ alchemy: 230 }), lastLogin: "2026-11-05T09:00:00.000Z" }));
  assert.deepEqual(skillRows(store.milestonesFor("Ann")), [
    ["alchemy:150", "observed", "2026-11-02T00:00:00.000Z", false],
    ["alchemy:225", "observed", "2026-11-04T00:00:00.000Z", true],
    ["alchemy:75", "observed", "2026-11-02T00:00:00.000Z", false],
  ]);
  // 2026-11-02 is outside the two-day window; 2026-11-04 is inside it.
  assert.deepEqual(posts, [["Ann", ["First to reach 225 Alchemy"]]]);
});

test("a launch member's profession tiers are backfilled from a Journeyman achievement; nothing is announced", async () => {
  const { store, rec, posts } = setup();
  rec.recordRoster([roster("Grom", 5)]);
  await rec.recordArmory(member("Grom", 5), info({
    level: 5,
    professions: crafts({ alchemy: 160 }),
    milestoneAchievements: [{ kind: "skill", key: "alchemy:150", classId: null, completedAt: "2026-10-01T00:00:00.000Z" }],
  }));
  assert.deepEqual(skillRows(store.milestonesFor("Grom")), [
    ["alchemy:150", "achievement", "2026-10-01T00:00:00.000Z", false],
    ["alchemy:75", "before_tracking", null, false],
  ]);
  assert.deepEqual(posts, []);
});

test("a newcomer who arrives with profession tiers gets them as before_joining", async () => {
  const { store, rec, posts, nextDay } = setup();
  rec.recordRoster([roster("Grom", 20)]);
  nextDay();
  rec.recordRoster([roster("Grom", 20), roster("Vet", 5)]);
  await rec.recordArmory(member("Vet", 5), info({ level: 5, professions: crafts({ alchemy: 230 }) }));
  assert.deepEqual(skillRows(store.milestonesFor("Vet")), [
    ["alchemy:150", "before_joining", null, false],
    ["alchemy:225", "before_joining", null, false],
    ["alchemy:75", "before_joining", null, false],
  ]);
  assert.deepEqual(posts, []);
});
