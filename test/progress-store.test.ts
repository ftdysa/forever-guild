import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.js";
import { ProgressStore, utcDay, type NewMilestone } from "../src/progress-store.js";

const fresh = () => new ProgressStore(openDatabase(":memory:"));

test("utcDay formats a UTC date", () => {
  assert.equal(utcDay(Date.UTC(2026, 10, 5, 23, 59)), "2026-11-05");
});

test("an empty store has no tracking start and no rows", () => {
  const s = fresh();
  assert.equal(s.trackingSince(), null);
  assert.equal(s.firstDay("Grom"), null);
  assert.equal(s.latestBefore("Grom", "2026-11-05"), null);
  assert.deepEqual(s.snapshots(), []);
  assert.deepEqual(s.milestones(), []);
});

test("upsert inserts, merges same-day writes, and carries unknown fields forward from earlier days", () => {
  const s = fresh();
  s.upsertSnapshot("Grom", "2026-11-05", { classId: "warrior", level: 40 });
  s.upsertSnapshot("Grom", "2026-11-05", { race: "Orc", pvpRank: 2, honorableKills: 30, skills: { mining: 150 } });
  assert.deepEqual(s.get("grom", "2026-11-05"), {
    name: "Grom", day: "2026-11-05", classId: "warrior", race: "Orc", level: 40, pvpRank: 2, honorableKills: 30, skills: { mining: 150 },
  });
  s.upsertSnapshot("Grom", "2026-11-07", { classId: "warrior", level: 42 });
  assert.deepEqual(s.get("Grom", "2026-11-07"), {
    name: "Grom", day: "2026-11-07", classId: "warrior", race: "Orc", level: 42, pvpRank: 2, honorableKills: 30, skills: { mining: 150 },
  });
  assert.equal(s.latestBefore("Grom", "2026-11-07")?.day, "2026-11-05");
  assert.equal(s.latestBefore("Grom", "2026-11-05"), null);
  assert.equal(s.firstDay("GROM"), "2026-11-05");
  assert.equal(s.trackingSince(), "2026-11-05");
});

test("a first row without a class is rejected", () => {
  assert.throws(() => fresh().upsertSnapshot("Grom", "2026-11-05", { level: 3 }), /no class/);
});

test("upsertSnapshots writes many rows for one day; snapshots() orders by name then day", () => {
  const s = fresh();
  s.upsertSnapshots("2026-11-06", [
    { name: "zed", patch: { classId: "mage", level: 5 } },
    { name: "Arg", patch: { classId: "rogue", level: 9 } },
  ]);
  s.upsertSnapshot("Arg", "2026-11-05", { classId: "rogue", level: 8 });
  assert.deepEqual(s.snapshots().map((r) => [r.name, r.day, r.level]), [
    ["Arg", "2026-11-05", 8],
    ["Arg", "2026-11-06", 9],
    ["zed", "2026-11-06", 5],
  ]);
});

const sixty: NewMilestone = { name: "Grom", kind: "level", key: "60", classId: "warrior", race: "Orc", reachedAt: "2026-11-05T10:00:00.000Z", source: "observed" };

test("milestones are recorded once per character (any case), and can be marked announced", () => {
  const s = fresh();
  assert.equal(s.addMilestone(sixty), true);
  assert.equal(s.addMilestone({ ...sixty, name: "GROM", source: "before_tracking", reachedAt: null }), false);
  assert.deepEqual(s.milestonesFor("grom"), [{ ...sixty, announced: false }]);
  s.markAnnounced("grom", "level", "60");
  assert.deepEqual(s.milestones(), [{ ...sixty, announced: true }]);
});

test("wipe clears both tables", () => {
  const s = fresh();
  s.upsertSnapshot("Grom", "2026-11-05", { classId: "warrior", level: 40 });
  s.addMilestone(sixty);
  assert.deepEqual(s.wipe(), { snapshots: 1, milestones: 1 });
  assert.deepEqual(s.snapshots(), []);
  assert.deepEqual(s.milestones(), []);
});

test("latestBelowLevel finds the latest earlier row under the level, skipping rows at or above it", () => {
  const s = fresh();
  s.upsertSnapshot("Grom", "2026-11-05", { classId: "warrior", level: 58 });
  s.upsertSnapshot("Grom", "2026-11-06", { level: 59 });
  s.upsertSnapshot("Grom", "2026-11-07", { level: 60 });
  s.upsertSnapshot("Grom", "2026-11-08", { level: 60 });
  assert.equal(s.latestBelowLevel("grom", "2026-11-09", 60)?.day, "2026-11-06");
  assert.equal(s.latestBelowLevel("Grom", "2026-11-06", 60)?.day, "2026-11-05");
  assert.equal(s.latestBelowLevel("Grom", "2026-11-05", 60), null);
  assert.equal(s.latestBelowLevel("Nobody", "2026-11-09", 60), null);
});

test("firstAtOrAbove finds the earliest row after a day at or above the level", () => {
  const s = fresh();
  s.upsertSnapshot("Grom", "2026-11-01", { classId: "warrior", level: 18 });
  s.upsertSnapshot("Grom", "2026-11-02", { level: 19 });
  s.upsertSnapshot("Grom", "2026-11-03", { level: 22 });
  s.upsertSnapshot("Grom", "2026-11-05", { level: 31 });
  assert.equal(s.firstAtOrAbove("grom", "2026-11-01", 20)?.day, "2026-11-03");
  assert.equal(s.firstAtOrAbove("Grom", "2026-11-03", 20)?.day, "2026-11-05");
  assert.equal(s.firstAtOrAbove("Grom", "2026-11-01", 40), null);
  assert.equal(s.firstAtOrAbove("Nobody", "2026-11-01", 20), null);
});
