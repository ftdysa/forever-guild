import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Professions, RosterEntry } from "./armory.js";
import type { MemberDetails } from "./validate.js";

// A guild member: identity, class, level and professions come from the guild roster and armory;
// MemberDetails are entered on the site.
// Armory facts shown on the roster, refreshed by the guild sync. null until first read.
export interface MemberArmory {
  race: string | null;
  gender: string | null;
  faction: "horde" | "alliance" | null;
  title: string | null;
  itemLevel: number | null;
  lastLogin: string | null;
  achievementPoints: number | null;
  // Forever only; account-wide.
  legacy: { earned: number; total: number } | null;
  skills: Professions["skills"];
  // Known recipe ids (crafting directory).
  recipes: number[];
}

export interface Member extends MemberDetails {
  id: number;
  characterName: string;
  // Forever only.
  surname: string | null;
  mainClass: string;
  level: number;
  guildRank: number;
  primaryProfessions: string[];
  secondaryProfessions: string[];
  armory: MemberArmory | null;
  createdAt: string;
  updatedAt: string;
}

// A guild roster row whose class we model.
export type RosterMember = RosterEntry & { classId: string };

interface Row {
  id: number;
  character_name: string;
  surname: string | null;
  main_class: string;
  main_spec: string | null;
  level: number;
  guild_rank: number;
  backup_class: string | null;
  backup_spec: string | null;
  primary_professions: string;
  secondary_professions: string;
  armory: string | null;
  sweat_factor: string | null;
  leveling_pref: string | null;
  notes: string;
  created_at: string;
  updated_at: string;
}

const membersTable = (name: string) => `
CREATE TABLE IF NOT EXISTS ${name} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_name TEXT NOT NULL COLLATE NOCASE,
  surname TEXT,
  main_class TEXT NOT NULL,
  main_spec TEXT,
  level INTEGER NOT NULL DEFAULT 0,
  guild_rank INTEGER NOT NULL DEFAULT 0,
  backup_class TEXT,
  backup_spec TEXT,
  primary_professions TEXT NOT NULL DEFAULT '[]',
  secondary_professions TEXT NOT NULL DEFAULT '[]',
  armory TEXT,
  sweat_factor TEXT,
  leveling_pref TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`;

// Columns carried over from hand-entered rosters when rebuilding an old table.
const LEGACY_COLUMNS = [
  "id", "character_name", "main_class", "main_spec", "backup_class", "backup_spec", "primary_professions",
  "secondary_professions", "sweat_factor", "leveling_pref", "notes", "created_at", "updated_at",
];

// Forever lets characters share a first name, so a character is its first name plus surname
// (null off Forever), case-insensitively.
const IDENTITY_INDEX =
  "CREATE UNIQUE INDEX IF NOT EXISTS members_identity ON members (character_name COLLATE NOCASE, IFNULL(surname, '') COLLATE NOCASE)";
const identity = (name: string, surname: string | null) => `${name.toLowerCase()}\u0000${(surname ?? "").toLowerCase()}`;

function rowToMember(r: Row): Member {
  return {
    id: r.id,
    characterName: r.character_name,
    surname: r.surname,
    mainClass: r.main_class,
    mainSpec: r.main_spec,
    level: r.level,
    guildRank: r.guild_rank,
    backupClass: r.backup_class,
    backupSpec: r.backup_spec,
    primaryProfessions: JSON.parse(r.primary_professions) as string[],
    secondaryProfessions: JSON.parse(r.secondary_professions) as string[],
    armory: r.armory ? (JSON.parse(r.armory) as MemberArmory) : null,
    sweatFactor: r.sweat_factor,
    levelingPref: r.leveling_pref,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// One connection per process, shared by every store; the caller owns closing it.
export function openDatabase(dbPath: string): Database.Database {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  return db;
}

export class MemberStore {
  constructor(private db: Database.Database) {
    this.migrate();
    this.db.exec(membersTable("members"));
    // Added after the guild-sync schema; plain ALTER is enough for nullable columns.
    const cols = this.columns("members");
    for (const col of ["surname", "armory"]) {
      if (!cols.includes(col)) this.db.exec(`ALTER TABLE members ADD COLUMN ${col} TEXT`);
    }
    this.migrateIdentity();
    this.db.exec(IDENTITY_INDEX);
  }

  private columns(table: string): string[] {
    return (this.db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);
  }

  // Tables from the hand-entered roster era have a NOT NULL main_spec and no level or rank.
  // SQLite can't relax NOT NULL in place, so such a table is rebuilt once, keeping its rows.
  private migrate(): void {
    const cols = this.columns("members");
    if (cols.length === 0 || cols.includes("level")) return;
    this.rebuild((c) => LEGACY_COLUMNS.includes(c));
  }

  // Older tables made the first name alone UNIQUE, which breaks on two characters sharing it.
  // SQLite can't drop a column constraint in place, so such a table is rebuilt once with every
  // row, id and column; the identity index replaces the constraint.
  private migrateIdentity(): void {
    const sql = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'members'").pluck().get() as string;
    if (/\bUNIQUE\b/i.test(sql)) this.rebuild(() => true);
  }

  // Recreates members with the current schema in one transaction, copying the old table's
  // columns that `keep` accepts and the new table has. The id sequence carries over, so ids
  // freed before the rebuild are never reused.
  private rebuild(keep: (column: string) => boolean): void {
    this.db.transaction(() => {
      const seq = this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'members'").pluck().get() as number | undefined;
      this.db.exec(membersTable("members_new"));
      const fresh = this.columns("members_new");
      const cols = this.columns("members").filter((c) => keep(c) && fresh.includes(c)).join(", ");
      this.db.exec(`INSERT INTO members_new (${cols}) SELECT ${cols} FROM members`);
      this.db.exec("DROP TABLE members");
      this.db.exec("ALTER TABLE members_new RENAME TO members");
      if (seq !== undefined) this.db.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'members'").run(seq);
    })();
  }

  list(): Member[] {
    const rows = this.db.prepare("SELECT * FROM members ORDER BY character_name COLLATE NOCASE").all() as Row[];
    return rows.map(rowToMember);
  }

  get(id: number): Member | undefined {
    const row = this.db.prepare("SELECT * FROM members WHERE id = ?").get(id) as Row | undefined;
    return row ? rowToMember(row) : undefined;
  }

  // Makes the members table match the guild roster: adds newcomers, updates class/level/rank,
  // and removes characters no longer in the guild (with their details). Returns the newcomers.
  syncRoster(roster: RosterMember[]): Member[] {
    const now = new Date().toISOString();
    return this.db.transaction(() => {
      const members = this.list();
      const existing = new Map(members.map((m) => [identity(m.characterName, m.surname), m]));
      const insert = this.db.prepare(
        `INSERT INTO members (character_name, surname, main_class, level, guild_rank, created_at, updated_at)
         VALUES (@name, @surname, @classId, @level, @rank, @now, @now)`,
      );
      const update = this.db.prepare(
        `UPDATE members SET surname = @surname, main_class = @classId, level = @level, guild_rank = @rank, updated_at = @now
         WHERE id = @id`,
      );
      const row = (r: RosterMember) => ({ name: r.name, surname: r.surname ?? null, classId: r.classId, level: r.level, rank: r.rank, now });
      const apply = (r: RosterMember, m: Member) => {
        existing.delete(identity(m.characterName, m.surname));
        if (m.surname !== r.surname || m.mainClass !== r.classId || m.level !== r.level || m.guildRank !== r.rank) {
          update.run({ ...row(r), id: m.id });
        }
      };
      // A first name held by exactly one member and one roster entry is one character whose
      // surname changed (or was read for the first time), so they keep their row and details.
      const soloNames = (names: string[]) => {
        const lower = names.map((n) => n.toLowerCase());
        return new Set(lower.filter((n) => lower.indexOf(n) === lower.lastIndexOf(n)));
      };
      const soloRoster = soloNames(roster.map((r) => r.name));
      const soloMembers = soloNames(members.map((m) => m.characterName));
      const renamed = (name: string) =>
        soloRoster.has(name) && soloMembers.has(name) ? members.find((m) => m.characterName.toLowerCase() === name) : undefined;
      const unmatched: RosterMember[] = [];
      for (const r of roster) {
        const m = existing.get(identity(r.name, r.surname));
        if (m) apply(r, m);
        else unmatched.push(r);
      }
      const added: number[] = [];
      for (const r of unmatched) {
        const m = renamed(r.name.toLowerCase());
        if (m) apply(r, m);
        else added.push(Number(insert.run(row(r)).lastInsertRowid));
      }
      const remove = this.db.prepare("DELETE FROM members WHERE id = ?");
      for (const gone of existing.values()) remove.run(gone.id);
      return added.map((id) => this.get(id) as Member);
    })();
  }

  // Applies armory data: professions are replaced; the spec only fills an empty main spec, so a
  // spec someone chose on the site wins over the talent guess. `m` may be a stale snapshot (the
  // refresh runs in the background), so the empty-spec check happens in SQL, not here.
  applyArmory(
    m: Member,
    data: { spec: string | null; primary: string[]; secondary: string[]; armory: MemberArmory },
  ): void {
    const unchanged =
      (m.mainSpec !== null || data.spec === null) &&
      JSON.stringify(data.primary) === JSON.stringify(m.primaryProfessions) &&
      JSON.stringify(data.secondary) === JSON.stringify(m.secondaryProfessions) &&
      JSON.stringify(data.armory) === JSON.stringify(m.armory);
    if (unchanged) return;
    this.db
      .prepare(
        `UPDATE members SET main_spec = COALESCE(main_spec, @spec), primary_professions = @primary,
           secondary_professions = @secondary, armory = @armory, updated_at = @now WHERE id = @id`,
      )
      .run({
        id: m.id,
        spec: data.spec,
        primary: JSON.stringify(data.primary),
        secondary: JSON.stringify(data.secondary),
        armory: JSON.stringify(data.armory),
        now: new Date().toISOString(),
      });
  }

  updateDetails(id: number, d: MemberDetails): Member | undefined {
    const info = this.db
      .prepare(
        `UPDATE members SET main_spec = @mainSpec, backup_class = @backupClass, backup_spec = @backupSpec,
           sweat_factor = @sweatFactor, leveling_pref = @levelingPref, notes = @notes, updated_at = @now
         WHERE id = @id`,
      )
      .run({ ...d, id, now: new Date().toISOString() });
    return info.changes === 0 ? undefined : this.get(id);
  }
}

const CACHE_SCHEMA = `
CREATE TABLE IF NOT EXISTS armory_cache (
  key TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);`;

// JSON blobs from the Blizzard API, keyed by realm/guild/character.
export class ArmoryCache {
  private find: Database.Statement;
  private upsert: Database.Statement;
  private findTime: Database.Statement;

  constructor(db: Database.Database) {
    db.exec(CACHE_SCHEMA);
    this.find = db.prepare("SELECT body, fetched_at FROM armory_cache WHERE key = ?");
    this.upsert = db.prepare("INSERT OR REPLACE INTO armory_cache (key, body, fetched_at) VALUES (?, ?, ?)");
    this.findTime = db.prepare("SELECT fetched_at FROM armory_cache WHERE key = ?");
  }

  get(key: string): { value: unknown; fetchedAt: number } | undefined {
    const row = this.find.get(key) as { body: string; fetched_at: number } | undefined;
    return row ? { value: JSON.parse(row.body), fetchedAt: row.fetched_at } : undefined;
  }

  // The entry's write time without parsing its body (cheap check for large entries).
  fetchedAt(key: string): number | undefined {
    const row = this.findTime.get(key) as { fetched_at: number } | undefined;
    return row?.fetched_at;
  }

  set(key: string, value: unknown, now = Date.now()): void {
    this.upsert.run(key, JSON.stringify(value), now);
  }
}

// Removes every member and all cached armory data, e.g. when switching from a PoC guild
// to the real one. Sessions are left alone so nobody is logged out.
export function wipeGuildData(db: Database.Database): { members: number; cached: number } {
  return db.transaction(() => {
    const members = db.prepare("DELETE FROM members").run().changes;
    const cached = db.prepare("DELETE FROM armory_cache").run().changes;
    db.prepare("DELETE FROM sqlite_sequence WHERE name = 'members'").run();
    return { members, cached };
  })();
}
