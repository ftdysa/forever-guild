import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bracketsFor, claimedFirsts, computeFirsts, crossingDay, detectMilestones, LEVEL_MILESTONES, milestonesMet, SKILL_TIERS,
  type AchievementMilestone, type Bracket, type CharacterState, type DetectInput,
} from "../src/milestones.js";
import type { Milestone, Snapshot } from "../src/progress-store.js";

const NOW = "2026-11-10T12:00:00.000Z";
const LOGIN = "2026-11-10T08:00:00.000Z";
const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  name: "Grom", day: "2026-11-09", classId: "warrior", race: "Orc", level: 59, pvpRank: 0, honorableKills: 0, skills: {}, ...over,
});
// A bracket with only the snapshot below: the crossing is first seen today.
const below = (over: Partial<Snapshot> = {}, reached: Snapshot | null = null): Bracket => ({ below: snap(over), reached });
const state = (over: Partial<CharacterState> = {}): CharacterState => ({ classId: "warrior", race: "Orc", level: 60, skills: {}, pvpRank: 0, ...over });
// Most tests are about level 60, so 10-50 count as already recorded unless a test says otherwise.
const lower = ["10", "20", "30", "40", "50"].map((key) => ({ kind: "level" as const, key }));
const input = (over: Partial<DetectInput> = {}): DetectInput => ({
  name: "Grom", state: state(), prior: snap(), brackets: { "level:60": below() }, launchMember: false, achievements: [], lastLogin: LOGIN, now: NOW, ...over,
  existing: [...lower, ...(over.existing ?? [])],
});
const brief = (ms: { kind: string; key: string; source: string; reachedAt: string | null }[]) => ms.map((m) => [m.kind, m.key, m.source, m.reachedAt]);
const ranks = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: "pvp_rank" as const, key: String(i + 1) }));

test("milestonesMet: levels, every skill tier reached per profession in game order, every PvP rank up to the current one", () => {
  assert.deepEqual(SKILL_TIERS, [75, 150, 225, 300]);
  assert.deepEqual(
    milestonesMet(state({ classId: "mage", race: "Gnome", skills: { tailoring: 300, enchanting: 224, alchemy: 74 }, pvpRank: 3 })).map((m) => `${m.kind}:${m.key}`),
    [
      "level:10", "level:20", "level:30", "level:40", "level:50", "level:60",
      "skill:enchanting:75", "skill:enchanting:150",
      "skill:tailoring:75", "skill:tailoring:150", "skill:tailoring:225", "skill:tailoring:300",
      "pvp_rank:1", "pvp_rank:2", "pvp_rank:3",
    ],
  );
  assert.deepEqual(milestonesMet(state({ level: 9, race: null, pvpRank: null })), []);
});

test("milestonesMet: every level milestone at or below the current level, ascending, before skills and PvP", () => {
  assert.deepEqual(LEVEL_MILESTONES, [10, 20, 30, 40, 50, 60]);
  assert.deepEqual(
    milestonesMet(state({ level: 37, skills: { mining: 80 }, pvpRank: 1 })).map((m) => `${m.kind}:${m.key}`),
    ["level:10", "level:20", "level:30", "skill:mining:75", "pvp_rank:1"],
  );
});

test("a crossing of a lower threshold is observed; earlier thresholds already recorded are not re-added", () => {
  const i = input({ state: state({ level: 31 }), prior: snap({ level: 29 }), brackets: { "level:30": below({ level: 29 }) } });
  assert.deepEqual(brief(detectMilestones({ ...i, existing: lower.slice(0, 2) })), [["level", "30", "observed", LOGIN]]);
});

test("a launch member first seen at 35 gets 10, 20, 30 as before_tracking; a newcomer gets before_joining", () => {
  const base = { state: state({ level: 35 }), prior: null, brackets: {} };
  assert.deepEqual(brief(detectMilestones({ ...input({ ...base, launchMember: true }), existing: [] })), [
    ["level", "10", "before_tracking", null], ["level", "20", "before_tracking", null], ["level", "30", "before_tracking", null],
  ]);
  assert.deepEqual(brief(detectMilestones({ ...input(base), existing: [] })), [
    ["level", "10", "before_joining", null], ["level", "20", "before_joining", null], ["level", "30", "before_joining", null],
  ]);
});

test("a crossing since an earlier day is observed and dated by last login", () => {
  assert.deepEqual(brief(detectMilestones(input())), [["level", "60", "observed", LOGIN]]);
  // the stored row keeps the character's details
  const [m] = detectMilestones(input());
  assert.deepEqual([m.name, m.classId, m.race], ["Grom", "warrior", "Orc"]);
});

test("observed falls back to the crossing day (levels, skills) or now (PvP) when last login is missing, before the earlier snapshot, or in the future", () => {
  const s = state({ skills: { mining: 75 }, pvpRank: 1 });
  const brackets = { "level:60": below(), "skill:mining:75": below({ skills: { mining: 70 } }) };
  for (const lastLogin of [null, "2026-11-08T23:00:00.000Z", "2026-11-11T00:00:00.000Z"]) {
    assert.deepEqual(brief(detectMilestones(input({ state: s, brackets, lastLogin }))), [
      ["level", "60", "observed", "2026-11-10T00:00:00.000Z"],
      ["skill", "mining:75", "observed", "2026-11-10T00:00:00.000Z"],
      ["pvp_rank", "1", "observed", NOW],
    ]);
  }
});

test("milestones already recorded are not recorded again", () => {
  assert.deepEqual(detectMilestones(input({ existing: [{ kind: "level", key: "60" }] })), []);
});

test("skills and PvP are observed only when the earlier snapshot had armory data", () => {
  const s = state({ level: 59, skills: { mining: 80 }, pvpRank: 2 });
  const brackets = { "skill:mining:75": below({ skills: { mining: 70 } }) };
  assert.deepEqual(brief(detectMilestones(input({ state: s, prior: snap({ skills: { mining: 70 }, pvpRank: 1 }), brackets, existing: ranks(1) }))), [
    ["skill", "mining:75", "observed", LOGIN],
    ["pvp_rank", "2", "observed", LOGIN],
  ]);
  // race null: the armory was never read, so the earlier values are unknown
  const unread = { "skill:mining:75": below({ race: null }) };
  assert.deepEqual(brief(detectMilestones(input({ state: s, prior: snap({ race: null, pvpRank: null }), brackets: unread, existing: ranks(1) }))), [
    ["skill", "mining:75", "before_joining", null],
    ["pvp_rank", "2", "before_joining", null],
  ]);
});

test("a skill tier crossing is dated between the last snapshot below it and the first at or above it", () => {
  const s = state({ level: 59, skills: { alchemy: 230 } });
  const brackets = {
    "skill:alchemy:75": below({ day: "2026-11-01", skills: { alchemy: 60 } }, snap({ day: "2026-11-02", skills: { alchemy: 160 } })),
    "skill:alchemy:150": below({ day: "2026-11-01", skills: { alchemy: 60 } }, snap({ day: "2026-11-02", skills: { alchemy: 160 } })),
    "skill:alchemy:225": below({ day: "2026-11-02", skills: { alchemy: 160 } }, snap({ day: "2026-11-04", skills: { alchemy: 230 } })),
  };
  assert.deepEqual(brief(detectMilestones(input({ state: s, brackets, lastLogin: "2026-11-04T20:00:00.000Z" }))), [
    ["skill", "alchemy:75", "observed", "2026-11-02T00:00:00.000Z"],
    ["skill", "alchemy:150", "observed", "2026-11-02T00:00:00.000Z"],
    ["skill", "alchemy:225", "observed", "2026-11-04T20:00:00.000Z"],
  ]);
});

test("a PvP jump records every rank passed; a later drop removes nothing", () => {
  const jump = detectMilestones(input({ state: state({ level: 59, pvpRank: 7 }), prior: snap({ pvpRank: 4 }), existing: ranks(4) }));
  assert.deepEqual(brief(jump), [["pvp_rank", "5", "observed", LOGIN], ["pvp_rank", "6", "observed", LOGIN], ["pvp_rank", "7", "observed", LOGIN]]);
  assert.deepEqual(detectMilestones(input({ state: state({ level: 59, pvpRank: 5 }), prior: snap({ pvpRank: 7 }), existing: ranks(7) })), []);
});

test("launch members use a matching achievement's date, else before_tracking", () => {
  const achievements: AchievementMilestone[] = [
    { kind: "level", key: "60", classId: "warrior", completedAt: "2026-10-01T00:00:00.000Z" },
    { kind: "pvp_rank", key: "3", classId: null, completedAt: "2026-10-02T00:00:00.000Z" },
  ];
  assert.deepEqual(brief(detectMilestones(input({ state: state({ pvpRank: 3 }), prior: null, brackets: {}, launchMember: true, achievements }))), [
    ["level", "60", "achievement", "2026-10-01T00:00:00.000Z"],
    ["pvp_rank", "1", "before_tracking", null],
    ["pvp_rank", "2", "before_tracking", null],
    ["pvp_rank", "3", "achievement", "2026-10-02T00:00:00.000Z"],
  ]);
});

test("a launch member already at 60 on an earlier day (armory failed then) still gets launch treatment", () => {
  assert.deepEqual(brief(detectMilestones(input({ prior: snap({ level: 60 }), brackets: {}, launchMember: true }))), [["level", "60", "before_tracking", null]]);
});

test("an achievement for another class, or dated in the future, is not trusted", () => {
  for (const a of [
    { kind: "level", key: "60", classId: "druid", completedAt: "2026-10-01T00:00:00.000Z" },
    { kind: "level", key: "60", classId: "warrior", completedAt: "2026-12-01T00:00:00.000Z" },
  ] as AchievementMilestone[]) {
    assert.deepEqual(brief(detectMilestones(input({ prior: null, brackets: {}, launchMember: true, achievements: [a] }))), [["level", "60", "before_tracking", null]]);
  }
});

test("newcomers already past a milestone are before_joining", () => {
  assert.deepEqual(brief(detectMilestones(input({ prior: null, brackets: {} }))), [["level", "60", "before_joining", null]]);
});

const ms = (name: string, kind: Milestone["kind"], key: string, source: Milestone["source"], reachedAt: string | null, over: Partial<Milestone> = {}): Milestone => ({
  name, kind, key, classId: "warrior", race: "Orc", source, reachedAt, announced: false, ...over,
});

test("firsts: earliest dated holder first, ties by name, three at most; launch rows apart; newcomers excluded", () => {
  const all = [
    ms("Zug", "level", "60", "observed", "2026-11-05T00:00:00.000Z"),
    ms("Grom", "level", "60", "achievement", "2026-10-01T00:00:00.000Z"),
    ms("Arg", "level", "60", "observed", "2026-11-05T00:00:00.000Z"),
    ms("Old", "level", "60", "before_tracking", null),
    ms("Late", "level", "60", "before_joining", null),
    ms("Fourth", "level", "60", "observed", "2026-11-06T00:00:00.000Z"),
  ];
  const f = computeFirsts(all, ["grom", "ARG", "Old"]);
  assert.deepEqual(f.byLevel["60"].holders.map((h) => [h.name, h.current, h.source]), [
    ["Grom", true, "achievement"],
    ["Arg", true, "observed"],
    ["Zug", false, "observed"],
  ]);
  assert.deepEqual(f.byLevel["60"].atLaunch, ["Old"]);
  assert.deepEqual(f.byClassLevel.warrior["60"].holders.map((h) => h.name), ["Grom", "Arg", "Zug"]);
  assert.deepEqual(f.byClassLevel.mage["60"], { holders: [], atLaunch: [] });
  assert.deepEqual(Object.keys(f.byRace), ["Orc"]);
  assert.equal(Object.keys(f.bySkill).length, 12);
  assert.deepEqual(Object.keys(f.bySkill.alchemy), ["75", "150", "225", "300"]);
  assert.deepEqual(Object.keys(f.byPvpRank), Array.from({ length: 14 }, (_, i) => String(i + 1)));
});

test("firsts: byLevel covers 10 to 60; byClassLevel holds each class's earliest at every level", () => {
  const f = computeFirsts([
    ms("Late", "level", "30", "observed", "2026-11-06T00:00:00.000Z"),
    ms("Early", "level", "30", "observed", "2026-11-02T00:00:00.000Z"),
    ms("Mage", "level", "30", "observed", "2026-11-01T00:00:00.000Z", { classId: "mage" }),
  ]);
  assert.deepEqual(Object.keys(f.byLevel), ["10", "20", "30", "40", "50", "60"]);
  assert.deepEqual(f.byClassLevel.warrior["30"].holders.map((h) => h.name), ["Early", "Late"]);
  assert.deepEqual(f.byLevel["30"].holders.map((h) => h.name), ["Mage", "Early", "Late"]);
  assert.deepEqual(Object.keys(f.byClassLevel.mage), ["10", "20", "30", "40", "50", "60"]);
  assert.deepEqual(f.byRace, {});
});

test("firsts: races passed in appear even when unclaimed, sorted", () => {
  assert.deepEqual(computeFirsts([], [], ["Troll", "Gnome"]).byRace, { Gnome: { holders: [], atLaunch: [] }, Troll: { holders: [], atLaunch: [] } });
});

test("claimedFirsts: lower levels claim only the overall first; class and race labels are level 60 only", () => {
  const grom = ms("Grom", "level", "20", "observed", "2026-11-05T00:00:00.000Z");
  assert.deepEqual(claimedFirsts(grom, computeFirsts([grom])), ["First to reach level 20"]);
  const early = ms("Early", "level", "20", "observed", "2026-11-01T00:00:00.000Z");
  assert.deepEqual(claimedFirsts(grom, computeFirsts([early, grom])), []);
});

test("claimedFirsts lists only the categories the milestone now leads", () => {
  const grom = ms("Grom", "level", "60", "observed", "2026-11-05T00:00:00.000Z", { classId: "shaman" });
  assert.deepEqual(claimedFirsts(grom, computeFirsts([ms("Early", "level", "60", "observed", "2026-11-01T00:00:00.000Z"), grom])), [
    "First Shaman to reach level 60",
  ]);
  assert.deepEqual(claimedFirsts(grom, computeFirsts([grom])), [
    "First to reach level 60",
    "First Shaman to reach level 60",
    "First Orc to reach level 60",
  ]);
  const tailor = ms("Grom", "skill", "tailoring:300", "observed", "2026-11-05T00:00:00.000Z");
  assert.deepEqual(claimedFirsts(tailor, computeFirsts([tailor])), ["First to reach 300 Tailoring"]);
  const alchemy = ms("Grom", "skill", "alchemy:150", "observed", "2026-11-05T00:00:00.000Z");
  assert.deepEqual(claimedFirsts(alchemy, computeFirsts([alchemy])), ["First to reach 150 Alchemy"]);
  assert.equal(computeFirsts([alchemy]).bySkill.alchemy["150"].holders[0].name, "Grom");
  assert.deepEqual(computeFirsts([alchemy]).bySkill.alchemy["300"].holders, []);
  const rank = ms("Grom", "pvp_rank", "7", "observed", "2026-11-05T00:00:00.000Z");
  assert.deepEqual(claimedFirsts(rank, computeFirsts([rank])), ["First to reach PvP rank 7"]);
});

test("a level crossing is dated between the last snapshot below and the first at or above it", () => {
  const below = snap({ day: "2026-11-01", level: 18 });
  const at = snap({ day: "2026-11-02", level: 22 });
  const base = { state: state({ level: 31 }), prior: snap({ day: "2026-11-09", level: 31 }), brackets: { "level:20": { below, reached: at } } };
  const twenty = (lastLogin: string | null) =>
    brief(detectMilestones({ ...input({ ...base, lastLogin }), existing: [{ kind: "level", key: "10" }, { kind: "level", key: "30" }] }));
  // last login today is long after the crossing: date it by the first snapshot at or above
  assert.deepEqual(twenty(LOGIN), [["level", "20", "observed", "2026-11-02T00:00:00.000Z"]]);
  assert.deepEqual(twenty(null), [["level", "20", "observed", "2026-11-02T00:00:00.000Z"]]);
  // a login inside the window is the session it happened in
  assert.deepEqual(twenty("2026-11-02T21:00:00.000Z"), [["level", "20", "observed", "2026-11-02T21:00:00.000Z"]]);
  assert.deepEqual(twenty("2026-11-01T03:00:00.000Z"), [["level", "20", "observed", "2026-11-01T03:00:00.000Z"]]);
});

test("crossingDay: levels and skills use the first snapshot at or above, else today; PvP today", () => {
  const i = input({
    brackets: {
      "level:60": below({}, snap({ day: "2026-11-08", level: 60 })),
      "skill:mining:150": below({ day: "2026-11-05" }, snap({ day: "2026-11-07", skills: { mining: 150 } })),
    },
  });
  assert.equal(crossingDay({ kind: "level", key: "60" }, i), "2026-11-08");
  assert.equal(crossingDay({ kind: "level", key: "50" }, i), "2026-11-10");
  assert.equal(crossingDay({ kind: "skill", key: "mining:150" }, i), "2026-11-07");
  assert.equal(crossingDay({ kind: "skill", key: "mining:75" }, i), "2026-11-10");
  assert.equal(crossingDay({ kind: "pvp_rank", key: "1" }, i), "2026-11-10");
});

test("bracketsFor: per level and skill milestone met, the latest earlier-day snapshot below it and the first later one at or above it", () => {
  const history = [
    snap({ day: "2026-11-01", level: 18, race: null, skills: {} }),
    snap({ day: "2026-11-02", level: 22, skills: { alchemy: 60 } }),
    snap({ day: "2026-11-03", level: 22, skills: { alchemy: 160 } }),
    snap({ day: "2026-11-05", level: 31, skills: { alchemy: 230 } }),
  ];
  const b = bracketsFor(state({ level: 31, skills: { alchemy: 230 }, pvpRank: 2 }), history, "2026-11-05");
  const days = Object.fromEntries(Object.entries(b).map(([id, x]) => [id, [x.below.day, x.reached?.day ?? null]]));
  // level 10: never seen below it, so no bracket
  assert.deepEqual(days, {
    "level:20": ["2026-11-01", "2026-11-02"],
    "level:30": ["2026-11-03", "2026-11-05"],
    // 2026-11-01 had no armory data (race null), so it can't show a skill below a tier
    "skill:alchemy:75": ["2026-11-02", "2026-11-03"],
    "skill:alchemy:150": ["2026-11-02", "2026-11-03"],
    "skill:alchemy:225": ["2026-11-03", "2026-11-05"],
  });
  // only earlier days count as "below"
  assert.deepEqual(bracketsFor(state({ level: 31 }), [snap({ day: "2026-11-05", level: 5 })], "2026-11-05"), {});
});

test("claimedFirsts with an earlier view: a category that already had a dated holder is not claimed again", () => {
  const ann = ms("Ann", "level", "20", "observed", "2026-11-02T10:00:00.000Z");
  const bob = ms("Bob", "level", "20", "observed", "2026-11-02T09:00:00.000Z");
  assert.deepEqual(claimedFirsts(bob, computeFirsts([ann, bob]), computeFirsts([ann])), []);
  assert.deepEqual(claimedFirsts(ann, computeFirsts([ann]), computeFirsts([])), ["First to reach level 20"]);
  // launch rows are not dated holders
  const old = ms("Old", "level", "20", "before_tracking", null);
  assert.deepEqual(claimedFirsts(ann, computeFirsts([old, ann]), computeFirsts([old])), ["First to reach level 20"]);
});
