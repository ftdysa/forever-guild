import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDetails } from "../src/validate.js";

// Thrall's synced class is shaman; the payload holds only the editable details.
const CLASS = "shaman";
const good = {
  mainSpec: "restoration",
  backupClass: "warrior",
  backupSpec: "protection",
  sweatFactor: "sweaty",
  levelingPref: "duo",
  notes: "  raid lead  ",
};

const validate = (input: unknown) => validateDetails(input, CLASS);
function errorsOf(input: unknown): string[] {
  const r = validate(input);
  return r.ok ? [] : r.errors;
}

test("accepts a valid payload and normalizes it", () => {
  const r = validate(good);
  assert.ok(r.ok);
  assert.deepEqual(r.value, {
    mainSpec: "restoration",
    backupClass: "warrior",
    backupSpec: "protection",
    sweatFactor: "sweaty",
    levelingPref: "duo",
    notes: "raid lead",
  });
});

test("everything is optional", () => {
  const r = validate({});
  assert.ok(r.ok);
  assert.deepEqual(r.value, { mainSpec: null, backupClass: null, backupSpec: null, sweatFactor: null, levelingPref: null, notes: "" });
});

test("rejects non-object input", () => {
  assert.deepEqual(errorsOf(null), ["payload must be an object"]);
  assert.deepEqual(errorsOf("x"), ["payload must be an object"]);
});

test("main spec must belong to the synced class", () => {
  assert.ok(errorsOf({ ...good, mainSpec: "protection" }).includes("mainSpec does not belong to the main class"));
  assert.ok(errorsOf({ ...good, mainSpec: 3 }).includes("mainSpec must be a string or null"));
  assert.ok(validate({ ...good, mainSpec: "" }).ok);
});

test("backup rules", () => {
  assert.ok(errorsOf({ ...good, backupClass: "necromancer" }).includes("backupClass is not a known class"));
  assert.ok(errorsOf({ ...good, backupClass: "warrior", backupSpec: null }).includes("backupSpec is required when backupClass is set"));
  assert.ok(errorsOf({ ...good, backupClass: "warrior", backupSpec: "holy" }).includes("backupSpec does not belong to backupClass"));
  assert.ok(errorsOf({ ...good, backupClass: "shaman", backupSpec: "restoration" }).includes("backup cannot be the same class and spec as main"));
  assert.ok(validate({ ...good, backupClass: "shaman", backupSpec: "elemental" }).ok);
  // backupSpec without backupClass is ignored (normalized to null)
  const r = validate({ ...good, backupClass: null, backupSpec: "holy" });
  assert.ok(r.ok);
  assert.equal(r.value.backupSpec, null);
});

test("backup fields must be a string or null", () => {
  assert.ok(errorsOf({ ...good, backupClass: 5 }).includes("backupClass must be a string or null"));
  assert.ok(errorsOf({ ...good, backupSpec: 5 }).includes("backupSpec must be a string or null"));
});

test("sweat factor and leveling pref are optional choices", () => {
  for (const empty of [undefined, null, ""]) {
    const r = validate({ ...good, sweatFactor: empty, levelingPref: empty });
    assert.ok(r.ok);
    assert.equal(r.value.sweatFactor, null);
    assert.equal(r.value.levelingPref, null);
  }
  assert.ok(validate({ ...good, sweatFactor: "world-first", levelingPref: "orgy" }).ok);
  assert.ok(errorsOf({ ...good, sweatFactor: "tryhard" }).includes("sweatFactor is not a known sweat factor"));
  assert.ok(errorsOf({ ...good, sweatFactor: 3 }).includes("sweatFactor is not a known sweat factor"));
  assert.ok(errorsOf({ ...good, levelingPref: "trio" }).includes("levelingPref is not a known leveling preference"));
  assert.ok(errorsOf({ ...good, levelingPref: ["solo"] }).includes("levelingPref is not a known leveling preference"));
});

test("notes rules", () => {
  assert.ok(errorsOf({ ...good, notes: "x".repeat(281) }).includes("notes must be at most 280 characters"));
  assert.ok(errorsOf({ ...good, notes: 5 }).includes("notes must be at most 280 characters"));
});

test("collects multiple errors at once", () => {
  assert.ok(errorsOf({ ...good, mainSpec: "fire", sweatFactor: "x", notes: 5 }).length >= 3);
});
