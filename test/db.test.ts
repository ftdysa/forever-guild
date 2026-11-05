import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArmoryCache, MemberStore, openDatabase, wipeGuildData, type RosterMember } from "../src/db.js";
import { SessionStore } from "../src/sessions.js";

const thrall: RosterMember = { name: "Thrall", surname: "Durotan", slug: "thrall-durotan", classId: "shaman", level: 14, rank: 0 };
const jaina: RosterMember = { name: "Jaina", surname: "Proudmoore", slug: "jaina-proudmoore", classId: "mage", level: 12, rank: 3 };
const details = { mainSpec: "frost", backupClass: "priest", backupSpec: "holy", sweatFactor: "world-first", levelingPref: "duo", notes: "portals" };

const ARMORY = { race: "Human", gender: "Female", faction: "alliance" as const, title: null, itemLevel: 12, lastLogin: null, achievementPoints: 0, legacy: { earned: 1, total: 65 }, skills: {} };

let db: Database.Database;
let store: MemberStore;
beforeEach(() => {
  db = openDatabase(":memory:");
  store = new MemberStore(db);
});
afterEach(() => db.close());

test("syncRoster adds newcomers with empty details, sorted by name", () => {
  const added = store.syncRoster([thrall, jaina]);
  assert.deepEqual(added.map((m) => m.characterName).sort(), ["Jaina", "Thrall"]);
  const [j, t] = store.list();
  assert.equal(j.characterName, "Jaina");
  assert.equal(t.characterName, "Thrall");
  assert.deepEqual(
    { ...j, id: 0, createdAt: "", updatedAt: "" },
    {
      id: 0,
      characterName: "Jaina",
      surname: "Proudmoore",
      mainClass: "mage",
      mainSpec: null,
      level: 12,
      guildRank: 3,
      backupClass: null,
      backupSpec: null,
      primaryProfessions: [],
      secondaryProfessions: [],
      armory: null,
      sweatFactor: null,
      levelingPref: null,
      notes: "",
      createdAt: "",
      updatedAt: "",
    },
  );
});

test("syncRoster updates level and rank, keeps details, and removes leavers", () => {
  store.syncRoster([thrall, jaina]);
  const j = store.list()[0];
  store.updateDetails(j.id, details);
  const added = store.syncRoster([{ ...jaina, name: "JAINA", level: 20, rank: 1 }]);
  assert.deepEqual(added, []);
  const [only] = store.list();
  assert.equal(store.list().length, 1);
  assert.equal(only.id, j.id);
  assert.equal(only.level, 20);
  assert.equal(only.guildRank, 1);
  assert.equal(only.notes, "portals");
});

test("syncRoster picks up a changed surname", () => {
  const [m] = store.syncRoster([jaina]);
  store.syncRoster([{ ...jaina, surname: "Theramore" }]);
  assert.equal(store.get(m.id)?.surname, "Theramore");
});

test("a guild-sync table without surname gains the column, keeping rows", () => {
  const raw = openDatabase(":memory:");
  raw.exec(`CREATE TABLE members (
    id INTEGER PRIMARY KEY AUTOINCREMENT, character_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    main_class TEXT NOT NULL, main_spec TEXT, level INTEGER NOT NULL DEFAULT 0, guild_rank INTEGER NOT NULL DEFAULT 0,
    backup_class TEXT, backup_spec TEXT, primary_professions TEXT NOT NULL DEFAULT '[]',
    secondary_professions TEXT NOT NULL DEFAULT '[]', sweat_factor TEXT, leveling_pref TEXT,
    notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  raw.exec(`INSERT INTO members (character_name, main_class, level, created_at, updated_at) VALUES ('Jaina', 'mage', 12, 'x', 'x')`);
  const s = new MemberStore(raw);
  assert.equal(s.list()[0].surname, null);
  s.syncRoster([jaina]);
  assert.equal(s.list()[0].surname, "Proudmoore");
  new MemberStore(raw); // idempotent
  raw.close();
});

test("applyArmory replaces professions and only fills an empty main spec", () => {
  const [m] = store.syncRoster([jaina]);
  store.applyArmory(store.get(m.id)!, { spec: "fire", primary: ["tailoring", "enchanting"], secondary: ["cooking"], armory: ARMORY });
  let got = store.get(m.id)!;
  assert.equal(got.mainSpec, "fire");
  assert.deepEqual(got.primaryProfessions, ["tailoring", "enchanting"]);
  store.updateDetails(m.id, { ...details, mainSpec: "frost" });
  store.applyArmory(store.get(m.id)!, { spec: "arcane", primary: ["tailoring"], secondary: [], armory: ARMORY });
  got = store.get(m.id)!;
  assert.equal(got.mainSpec, "frost");
  assert.deepEqual(got.primaryProfessions, ["tailoring"]);
  assert.deepEqual(got.secondaryProfessions, []);
});

test("applyArmory stores the armory snapshot and replaces it when it changes", () => {
  const [m] = store.syncRoster([jaina]);
  store.applyArmory(m, { spec: null, primary: [], secondary: [], armory: ARMORY });
  assert.deepEqual(store.get(m.id)!.armory, ARMORY);
  store.applyArmory(store.get(m.id)!, { spec: null, primary: [], secondary: [], armory: { ...ARMORY, itemLevel: 20 } });
  assert.equal(store.get(m.id)!.armory?.itemLevel, 20);
});

test("applyArmory with a stale snapshot never overwrites a spec chosen since", () => {
  const [m] = store.syncRoster([jaina]);
  store.updateDetails(m.id, { ...details, mainSpec: "frost" });
  store.applyArmory(m, { spec: "fire", primary: ["tailoring"], secondary: [], armory: ARMORY });
  assert.equal(store.get(m.id)!.mainSpec, "frost");
  assert.deepEqual(store.get(m.id)!.primaryProfessions, ["tailoring"]);
});

test("applyArmory leaves updatedAt alone when nothing changed", async () => {
  const [m] = store.syncRoster([jaina]);
  store.applyArmory(store.get(m.id)!, { spec: "fire", primary: [], secondary: [], armory: ARMORY });
  const before = store.get(m.id)!.updatedAt;
  await new Promise((r) => setTimeout(r, 5));
  store.applyArmory(store.get(m.id)!, { spec: "arcane", primary: [], secondary: [], armory: ARMORY });
  assert.equal(store.get(m.id)!.updatedAt, before);
});

test("updateDetails sets the editable fields; unknown id is undefined", () => {
  const [m] = store.syncRoster([jaina]);
  const u = store.updateDetails(m.id, details);
  assert.equal(u?.backupClass, "priest");
  assert.equal(u?.characterName, "Jaina");
  assert.equal(store.updateDetails(999, details), undefined);
  assert.equal(store.get(999), undefined);
});

test("a hand-entered roster table is rebuilt once, keeping rows and details", () => {
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
    old.exec(`INSERT INTO members (character_name, main_class, main_spec, primary_professions, secondary_professions, notes, created_at, updated_at)
      VALUES ('Thrall', 'shaman', 'restoration', '["alchemy","herbalism"]', '[]', 'warchief', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
    old.close();

    const sdb = openDatabase(path);
    const s = new MemberStore(sdb);
    const [m] = s.list();
    assert.equal(m.characterName, "Thrall");
    assert.equal(m.mainSpec, "restoration");
    assert.equal(m.notes, "warchief");
    assert.equal(m.level, 0);
    assert.equal(m.sweatFactor, null);
    // main_spec is nullable now
    const [fresh] = s.syncRoster([thrall, jaina]).filter((x) => x.characterName === "Jaina");
    assert.equal(fresh.mainSpec, null);
    sdb.close();
    // reopening an already-migrated database is a no-op
    const again = openDatabase(path);
    assert.equal(new MemberStore(again).list().length, 2);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("armory cache round-trips JSON with its fetch time", () => {
  const cache = new ArmoryCache(db);
  assert.equal(cache.get("k"), undefined);
  cache.set("k", { a: [1, 2] }, 42);
  assert.deepEqual(cache.get("k"), { value: { a: [1, 2] }, fetchedAt: 42 });
  cache.set("k", null, 43);
  assert.deepEqual(cache.get("k"), { value: null, fetchedAt: 43 });
});

test("wipeGuildData removes members and armory cache but keeps sessions", () => {
  const sessions = new SessionStore(db, "a-long-guild-passphrase", "s".repeat(32));
  const token = sessions.create();
  const cache = new ArmoryCache(db);
  store.syncRoster([thrall, jaina]);
  cache.set("k", {});
  assert.deepEqual(wipeGuildData(db), { members: 2, cached: 1 });
  assert.equal(store.list().length, 0);
  assert.equal(cache.get("k"), undefined);
  assert.ok(sessions.isValid(token));
  // ids restart after a wipe
  assert.equal(store.syncRoster([thrall])[0].id, 1);
});
