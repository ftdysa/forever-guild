import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  sweatFactor: null,
  levelingPref: null,
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
  sweatFactor: "world-first",
  levelingPref: "duo",
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
  assert.equal(j.sweatFactor, "world-first");
  assert.equal(j.levelingPref, "duo");
  assert.equal(t.sweatFactor, null);
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
  const u = store.update(t.id, { ...thrall, mainSpec: "elemental", notes: "zap", levelingPref: "solo" });
  assert.ok(u);
  assert.equal(u.levelingPref, "solo");
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

test("opening a pre-existing database adds the new columns and keeps rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "roster-"));
  const path = join(dir, "roster.db");
  try {
    const old = new Database(path);
    old.exec(`CREATE TABLE members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      main_class TEXT NOT NULL, main_spec TEXT NOT NULL,
      backup_class TEXT, backup_spec TEXT,
      primary_professions TEXT NOT NULL, secondary_professions TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    old.exec(`INSERT INTO members (character_name, main_class, main_spec, primary_professions, secondary_professions, created_at, updated_at)
      VALUES ('Thrall', 'shaman', 'restoration', '["alchemy","herbalism"]', '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
    old.close();

    const s = new MemberStore(path);
    const [m] = s.list();
    assert.equal(m.characterName, "Thrall");
    assert.equal(m.sweatFactor, null);
    assert.equal(m.levelingPref, null);
    const u = s.update(m.id, { ...thrall, sweatFactor: "meh", levelingPref: "orgy" });
    assert.equal(u?.sweatFactor, "meh");
    s.close();
    // reopening an already-migrated database is a no-op
    new MemberStore(path).close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
