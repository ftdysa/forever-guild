import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLASSES,
  PROFESSIONS,
  findClass,
  findSpec,
  gameData,
  SWEAT_TIERS,
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
  const ids = (kind: string) => PROFESSIONS.filter((p) => p.kind === kind).map((p) => p.id);
  assert.equal(ids("primary").length, 9);
  assert.equal(PROFESSIONS.length, 12);
  assert.deepEqual(ids("secondary"), ["cooking", "fishing", "first-aid"]);
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

test("sweat tiers and leveling prefs are ordered as specified", () => {
  assert.deepEqual(
    SWEAT_TIERS.map((t) => [t.id, t.name, t.min]),
    [
      ["bone-dry", "Bone Dry", 0],
      ["glistening", "Glistening", 15],
      ["damp", "Damp", 35],
      ["drenched", "Drenched", 55],
      ["swamp-ass", "Swamp Ass", 72],
      ["turbo-sweat", "Turbo Sweat", 88],
    ],
  );
  assert.deepEqual(LEVELING_PREFS.map((c) => c.id), ["solo", "duo", "orgy"]);
});

test("gameData returns classes, professions, and preference choices", () => {
  const d = gameData();
  assert.equal(d.classes.length, 9);
  assert.equal(d.professions.length, 12);
  assert.equal(d.sweatTiers, SWEAT_TIERS);
  assert.equal(d.levelingPrefs, LEVELING_PREFS);
});
