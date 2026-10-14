import { test } from "node:test";
import assert from "node:assert/strict";
import { validateMember } from "../src/validate.js";

const good = {
  characterName: "  Thrall ",
  mainClass: "shaman",
  mainSpec: "restoration",
  backupClass: "warrior",
  backupSpec: "protection",
  primaryProfessions: ["alchemy", "herbalism"],
  secondaryProfessions: ["cooking", "first-aid"],
  notes: "  raid lead  ",
};

function errorsOf(input: unknown): string[] {
  const r = validateMember(input);
  return r.ok ? [] : r.errors;
}

test("accepts a valid payload and normalizes it", () => {
  const r = validateMember(good);
  assert.ok(r.ok);
  assert.deepEqual(r.value, {
    characterName: "Thrall",
    mainClass: "shaman",
    mainSpec: "restoration",
    backupClass: "warrior",
    backupSpec: "protection",
    primaryProfessions: ["alchemy", "herbalism"],
    secondaryProfessions: ["cooking", "first-aid"],
    notes: "raid lead",
  });
});

test("accepts no backup and no secondaries and missing notes", () => {
  const r = validateMember({ ...good, backupClass: null, backupSpec: null, secondaryProfessions: [], notes: undefined });
  assert.ok(r.ok);
  assert.equal(r.value.backupClass, null);
  assert.equal(r.value.backupSpec, null);
  assert.deepEqual(r.value.secondaryProfessions, []);
  assert.equal(r.value.notes, "");
});

test("rejects non-object input", () => {
  assert.deepEqual(errorsOf(null), ["payload must be an object"]);
  assert.deepEqual(errorsOf("x"), ["payload must be an object"]);
});

test("character name rules", () => {
  assert.ok(errorsOf({ ...good, characterName: "A" }).includes("characterName must be 2-24 letters"));
  assert.ok(errorsOf({ ...good, characterName: "A".repeat(25) }).includes("characterName must be 2-24 letters"));
  assert.ok(errorsOf({ ...good, characterName: "Thr4ll" }).includes("characterName must be 2-24 letters"));
  assert.ok(errorsOf({ ...good, characterName: "Thr all" }).includes("characterName must be 2-24 letters"));
  assert.ok(errorsOf({ ...good, characterName: 7 }).includes("characterName must be 2-24 letters"));
  assert.ok(validateMember({ ...good, characterName: "Ælfwynn" }).ok);
});

test("main class and spec rules", () => {
  assert.ok(errorsOf({ ...good, mainClass: "necromancer" }).includes("mainClass is not a known class"));
  assert.ok(errorsOf({ ...good, mainSpec: "protection" }).includes("mainSpec does not belong to mainClass"));
  assert.ok(errorsOf({ ...good, mainSpec: 3 }).includes("mainSpec does not belong to mainClass"));
});

test("backup rules", () => {
  assert.ok(errorsOf({ ...good, backupClass: "necromancer" }).includes("backupClass is not a known class"));
  assert.ok(errorsOf({ ...good, backupClass: "warrior", backupSpec: null }).includes("backupSpec is required when backupClass is set"));
  assert.ok(errorsOf({ ...good, backupClass: "warrior", backupSpec: "holy" }).includes("backupSpec does not belong to backupClass"));
  assert.ok(errorsOf({ ...good, backupClass: "shaman", backupSpec: "restoration" }).includes("backup cannot be the same class and spec as main"));
  assert.ok(validateMember({ ...good, backupClass: "shaman", backupSpec: "elemental" }).ok);
  // backupSpec without backupClass is ignored (normalized to null)
  const r = validateMember({ ...good, backupClass: null, backupSpec: "holy" });
  assert.ok(r.ok);
  assert.equal(r.value.backupSpec, null);
});

test("primary profession rules", () => {
  assert.ok(errorsOf({ ...good, primaryProfessions: ["alchemy"] }).includes("primaryProfessions must be exactly 2 distinct primary professions"));
  assert.ok(errorsOf({ ...good, primaryProfessions: ["alchemy", "alchemy"] }).includes("primaryProfessions must be exactly 2 distinct primary professions"));
  assert.ok(errorsOf({ ...good, primaryProfessions: ["alchemy", "cooking"] }).includes("primaryProfessions must be exactly 2 distinct primary professions"));
  assert.ok(errorsOf({ ...good, primaryProfessions: "alchemy" }).includes("primaryProfessions must be exactly 2 distinct primary professions"));
});

test("secondary profession rules", () => {
  assert.ok(errorsOf({ ...good, secondaryProfessions: ["cooking", "cooking"] }).includes("secondaryProfessions must be distinct secondary professions"));
  assert.ok(errorsOf({ ...good, secondaryProfessions: ["alchemy"] }).includes("secondaryProfessions must be distinct secondary professions"));
  assert.ok(errorsOf({ ...good, secondaryProfessions: "cooking" }).includes("secondaryProfessions must be distinct secondary professions"));
  assert.ok(validateMember({ ...good, secondaryProfessions: undefined }).ok);
});

test("notes rules", () => {
  assert.ok(errorsOf({ ...good, notes: "x".repeat(281) }).includes("notes must be at most 280 characters"));
  assert.ok(errorsOf({ ...good, notes: 5 }).includes("notes must be at most 280 characters"));
});

test("collects multiple errors at once", () => {
  const errs = errorsOf({ ...good, characterName: "", mainClass: "x", primaryProfessions: [] });
  assert.ok(errs.length >= 3);
});
