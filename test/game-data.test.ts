import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLASSES,
  PROFESSIONS,
  PRIMARY_IDS,
  SECONDARY_IDS,
  findClass,
  findSpec,
  gameData,
  SWEAT_FACTORS,
  LEVELING_PREFS,
} from "../src/game-data.js";

test("has 9 classes with 3 specs each and a role on every spec", () => {
  assert.equal(CLASSES.length, 9);
  for (const c of CLASSES) {
    assert.equal(c.specs.length, 3, `${c.id} should have 3 specs`);
    assert.match(c.color, /^#[0-9A-F]{6}$/i);
    for (const s of c.specs) {
      assert.ok(["tank", "healer", "dps"].includes(s.role), `${c.id}/${s.id}`);
    }
  }
});

test("has 9 primary and 3 secondary professions", () => {
  assert.equal(PRIMARY_IDS.length, 9);
  assert.equal(SECONDARY_IDS.length, 3);
  assert.equal(PROFESSIONS.length, 12);
  assert.deepEqual(SECONDARY_IDS, ["cooking", "fishing", "first-aid"]);
});

test("class and spec ids are unique within scope", () => {
  const classIds = new Set(CLASSES.map((c) => c.id));
  assert.equal(classIds.size, 9);
  for (const c of CLASSES) {
    assert.equal(new Set(c.specs.map((s) => s.id)).size, 3);
  }
});

test("findClass / findSpec", () => {
  assert.equal(findClass("warrior")?.name, "Warrior");
  assert.equal(findClass("nope"), undefined);
  assert.equal(findSpec("warrior", "protection")?.role, "tank");
  assert.equal(findSpec("priest", "protection"), undefined);
  assert.equal(findSpec("nope", "protection"), undefined);
});

test("sweat factors and leveling prefs are ordered as specified", () => {
  assert.deepEqual(SWEAT_FACTORS.map((c) => c.id), ["meh", "casual", "interested", "sweaty", "world-first"]);
  assert.deepEqual(LEVELING_PREFS.map((c) => c.id), ["solo", "duo", "orgy"]);
});

test("gameData returns classes, professions, and preference choices", () => {
  const d = gameData();
  assert.equal(d.classes.length, 9);
  assert.equal(d.professions.length, 12);
  assert.equal(d.sweatFactors, SWEAT_FACTORS);
  assert.equal(d.levelingPrefs, LEVELING_PREFS);
});
