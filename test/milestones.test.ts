import { test } from "node:test";
import assert from "node:assert/strict";
import {
  claimedFirsts, computeFirsts, detectMilestones, LEVEL_MILESTONES, milestonesMet,
  type AchievementMilestone, type CharacterState, type DetectInput,
} from "../src/milestones.js";
import type { Milestone, Snapshot } from "../src/progress-store.js";

const NOW = "2026-11-10T12:00:00.000Z";
const LOGIN = "2026-11-10T08:00:00.000Z";
const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  name: "Grom", day: "2026-11-09", classId: "warrior", race: "Orc", level: 59, pvpRank: 0, honorableKills: 0, skills: {}, ...over,
});
const state = (over: Partial<CharacterState> = {}): CharacterState => ({ classId: "warrior", race: "Orc", level: 60, skills: {}, pvpRank: 0, ...over });
// Most tests are about level 60, so 10-50 count as already recorded unless a test says otherwise.
const lower = ["10", "20", "30", "40", "50"].map((key) => ({ kind: "level" as const, key }));
const input = (over: Partial<DetectInput> = {}): DetectInput => ({
  name: "Grom", state: state(), prior: snap(), priorBelowLevel: { "60": snap() }, launchMember: false, achievements: [], lastLogin: LOGIN, now: NOW, ...over,
  existing: [...lower, ...(over.existing ?? [])],
});
const brief = (ms: { kind: string; key: string; source: string; reachedAt: string | null }[]) => ms.map((m) => [m.kind, m.key, m.source, m.reachedAt]);
const ranks = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: "pvp_rank" as const, key: String(i + 1) }));

test("milestonesMet: level 60, 300 skill per profession, every PvP rank up to the current one", () => {
  assert.deepEqual(
    milestonesMet(state({ classId: "mage", race: "Gnome", skills: { tailoring: 300, enchanting: 299 }, pvpRank: 3 })).map((m) => `${m.kind}:${m.key}`),
    ["level:10", "level:20", "level:30", "level:40", "level:50", "level:60", "skill:tailoring", "pvp_rank:1", "pvp_rank:2", "pvp_rank:3"],
  );
  assert.deepEqual(milestonesMet(state({ level: 9, race: null, pvpRank: null })), []);
});

test("milestonesMet: every level milestone at or below the current level, ascending, before skills and PvP", () => {
  assert.deepEqual(LEVEL_MILESTONES, [10, 20, 30, 40, 50, 60]);
  assert.deepEqual(
    milestonesMet(state({ level: 37, skills: { mining: 300 }, pvpRank: 1 })).map((m) => `${m.kind}:${m.key}`),
    ["level:10", "level:20", "level:30", "skill:mining", "pvp_rank:1"],
  );
});

test("a crossing of a lower threshold is observed; earlier thresholds already recorded are not re-added", () => {
  const i = input({ state: state({ level: 31 }), prior: snap({ level: 29 }), priorBelowLevel: { "30": snap({ level: 29 }) } });
  assert.deepEqual(brief(detectMilestones({ ...i, existing: lower.slice(0, 2) })), [["level", "30", "observed", LOGIN]]);
});

test("a launch member first seen at 35 gets 10, 20, 30 as before_tracking; a newcomer gets before_joining", () => {
  const base = { state: state({ level: 35 }), prior: null, priorBelowLevel: {} };
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

test("observed falls back to now when last login is missing, before the earlier snapshot, or in the future", () => {
  for (const lastLogin of [null, "2026-11-08T23:00:00.000Z", "2026-11-11T00:00:00.000Z"]) {
    assert.deepEqual(brief(detectMilestones(input({ lastLogin }))), [["level", "60", "observed", NOW]]);
  }
});

test("milestones already recorded are not recorded again", () => {
  assert.deepEqual(detectMilestones(input({ existing: [{ kind: "level", key: "60" }] })), []);
});

test("skills and PvP are observed only when the earlier snapshot had armory data", () => {
  const s = state({ level: 59, skills: { mining: 300 }, pvpRank: 2 });
  assert.deepEqual(brief(detectMilestones(input({ state: s, prior: snap({ skills: { mining: 290 }, pvpRank: 1 }), existing: ranks(1) }))), [
    ["skill", "mining", "observed", LOGIN],
    ["pvp_rank", "2", "observed", LOGIN],
  ]);
  // race null: the armory was never read, so the earlier values are unknown
  assert.deepEqual(brief(detectMilestones(input({ state: s, prior: snap({ race: null, pvpRank: null }), existing: ranks(1) }))), [
    ["skill", "mining", "before_joining", null],
    ["pvp_rank", "2", "before_joining", null],
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
  assert.deepEqual(brief(detectMilestones(input({ state: state({ pvpRank: 3 }), prior: null, priorBelowLevel: {}, launchMember: true, achievements }))), [
    ["level", "60", "achievement", "2026-10-01T00:00:00.000Z"],
    ["pvp_rank", "1", "before_tracking", null],
    ["pvp_rank", "2", "before_tracking", null],
    ["pvp_rank", "3", "achievement", "2026-10-02T00:00:00.000Z"],
  ]);
});

test("a launch member already at 60 on an earlier day (armory failed then) still gets launch treatment", () => {
  assert.deepEqual(brief(detectMilestones(input({ prior: snap({ level: 60 }), priorBelowLevel: {}, launchMember: true }))), [["level", "60", "before_tracking", null]]);
});

test("an achievement for another class, or dated in the future, is not trusted", () => {
  for (const a of [
    { kind: "level", key: "60", classId: "druid", completedAt: "2026-10-01T00:00:00.000Z" },
    { kind: "level", key: "60", classId: "warrior", completedAt: "2026-12-01T00:00:00.000Z" },
  ] as AchievementMilestone[]) {
    assert.deepEqual(brief(detectMilestones(input({ prior: null, priorBelowLevel: {}, launchMember: true, achievements: [a] }))), [["level", "60", "before_tracking", null]]);
  }
});

test("newcomers already past a milestone are before_joining", () => {
  assert.deepEqual(brief(detectMilestones(input({ prior: null, priorBelowLevel: {} }))), [["level", "60", "before_joining", null]]);
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
  const tailor = ms("Grom", "skill", "tailoring", "observed", "2026-11-05T00:00:00.000Z");
  assert.deepEqual(claimedFirsts(tailor, computeFirsts([tailor])), ["First to reach 300 Tailoring"]);
  const rank = ms("Grom", "pvp_rank", "7", "observed", "2026-11-05T00:00:00.000Z");
  assert.deepEqual(claimedFirsts(rank, computeFirsts([rank])), ["First to reach PvP rank 7"]);
});
