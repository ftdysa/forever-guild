import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { MemberStore, DuplicateNameError } from "../src/db.js";
import type { MemberInput } from "../src/validate.js";

const thrall: MemberInput = {
  characterName: "Thrall",
  mainClass: "shaman",
  mainSpec: "restoration",
  backupClass: null,
  backupSpec: null,
  primaryProfessions: ["alchemy", "herbalism"],
  secondaryProfessions: ["cooking"],
  notes: "",
};

const jaina: MemberInput = {
  characterName: "Jaina",
  mainClass: "mage",
  mainSpec: "frost",
  backupClass: "priest",
  backupSpec: "holy",
  primaryProfessions: ["tailoring", "enchanting"],
  secondaryProfessions: [],
  notes: "portals",
};

let store: MemberStore;
beforeEach(() => {
  store = new MemberStore(":memory:");
});
afterEach(() => store.close());

test("create returns a member with id and timestamps, list is sorted by name", () => {
  const t = store.create(thrall);
  const j = store.create(jaina);
  assert.equal(typeof t.id, "number");
  assert.match(t.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(t.createdAt, t.updatedAt);
  assert.deepEqual(t.primaryProfessions, ["alchemy", "herbalism"]);
  assert.equal(j.backupSpec, "holy");
  assert.deepEqual(store.list().map((m) => m.characterName), ["Jaina", "Thrall"]);
});

test("get returns undefined for unknown id", () => {
  assert.equal(store.get(999), undefined);
});

test("duplicate name is rejected case-insensitively", () => {
  store.create(thrall);
  assert.throws(() => store.create({ ...thrall, characterName: "THRALL" }), DuplicateNameError);
});

test("update replaces fields and bumps updatedAt; keeps createdAt", async () => {
  const t = store.create(thrall);
  await new Promise((r) => setTimeout(r, 5));
  const u = store.update(t.id, { ...thrall, mainSpec: "elemental", notes: "zap" });
  assert.ok(u);
  assert.equal(u.mainSpec, "elemental");
  assert.equal(u.notes, "zap");
  assert.equal(u.createdAt, t.createdAt);
  assert.notEqual(u.updatedAt, t.updatedAt);
  assert.equal(store.update(999, thrall), undefined);
});

test("update to another member's name is rejected", () => {
  const t = store.create(thrall);
  store.create(jaina);
  assert.throws(() => store.update(t.id, { ...thrall, characterName: "jaina" }), DuplicateNameError);
  // renaming to own name with different case is fine
  assert.ok(store.update(t.id, { ...thrall, characterName: "THRALL" }));
});

test("delete returns true then false", () => {
  const t = store.create(thrall);
  assert.equal(store.delete(t.id), true);
  assert.equal(store.delete(t.id), false);
  assert.equal(store.list().length, 0);
});
