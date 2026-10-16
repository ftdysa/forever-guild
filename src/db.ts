import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { MemberInput } from "./validate.js";

export interface Member extends MemberInput {
  id: number;
  createdAt: string;
  updatedAt: string;
}

export class DuplicateNameError extends Error {
  constructor() {
    super("character name already taken");
    this.name = "DuplicateNameError";
  }
}

interface Row {
  id: number;
  character_name: string;
  main_class: string;
  main_spec: string;
  backup_class: string | null;
  backup_spec: string | null;
  primary_professions: string;
  secondary_professions: string;
  sweat_factor: string | null;
  leveling_pref: string | null;
  notes: string;
  created_at: string;
  updated_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  main_class TEXT NOT NULL,
  main_spec TEXT NOT NULL,
  backup_class TEXT,
  backup_spec TEXT,
  primary_professions TEXT NOT NULL,
  secondary_professions TEXT NOT NULL,
  sweat_factor TEXT,
  leveling_pref TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`;

// Columns added after the initial schema; ALTERed into existing databases on startup.
const ADDED_COLUMNS = ["sweat_factor", "leveling_pref"];

function rowToMember(r: Row): Member {
  return {
    id: r.id,
    characterName: r.character_name,
    mainClass: r.main_class,
    mainSpec: r.main_spec,
    backupClass: r.backup_class,
    backupSpec: r.backup_spec,
    primaryProfessions: JSON.parse(r.primary_professions) as string[],
    secondaryProfessions: JSON.parse(r.secondary_professions) as string[],
    sweatFactor: r.sweat_factor,
    levelingPref: r.leveling_pref,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE";
}

export class MemberStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  private migrate(): void {
    const existing = new Set((this.db.pragma("table_info(members)") as { name: string }[]).map((c) => c.name));
    for (const col of ADDED_COLUMNS) {
      if (!existing.has(col)) this.db.exec(`ALTER TABLE members ADD COLUMN ${col} TEXT`);
    }
  }

  list(): Member[] {
    const rows = this.db.prepare("SELECT * FROM members ORDER BY character_name COLLATE NOCASE").all() as Row[];
    return rows.map(rowToMember);
  }

  get(id: number): Member | undefined {
    const row = this.db.prepare("SELECT * FROM members WHERE id = ?").get(id) as Row | undefined;
    return row ? rowToMember(row) : undefined;
  }

  create(input: MemberInput): Member {
    const now = new Date().toISOString();
    try {
      const info = this.db
        .prepare(
          `INSERT INTO members (character_name, main_class, main_spec, backup_class, backup_spec,
             primary_professions, secondary_professions, sweat_factor, leveling_pref, notes, created_at, updated_at)
           VALUES (@characterName, @mainClass, @mainSpec, @backupClass, @backupSpec,
             @primaryProfessions, @secondaryProfessions, @sweatFactor, @levelingPref, @notes, @createdAt, @updatedAt)`,
        )
        .run({
          ...input,
          primaryProfessions: JSON.stringify(input.primaryProfessions),
          secondaryProfessions: JSON.stringify(input.secondaryProfessions),
          createdAt: now,
          updatedAt: now,
        });
      return this.get(Number(info.lastInsertRowid)) as Member;
    } catch (err) {
      if (isUniqueViolation(err)) throw new DuplicateNameError();
      throw err;
    }
  }

  update(id: number, input: MemberInput): Member | undefined {
    const now = new Date().toISOString();
    try {
      const info = this.db
        .prepare(
          `UPDATE members SET character_name = @characterName, main_class = @mainClass, main_spec = @mainSpec,
             backup_class = @backupClass, backup_spec = @backupSpec, primary_professions = @primaryProfessions,
             secondary_professions = @secondaryProfessions, sweat_factor = @sweatFactor,
             leveling_pref = @levelingPref, notes = @notes, updated_at = @updatedAt
           WHERE id = @id`,
        )
        .run({
          ...input,
          id,
          primaryProfessions: JSON.stringify(input.primaryProfessions),
          secondaryProfessions: JSON.stringify(input.secondaryProfessions),
          updatedAt: now,
        });
      if (info.changes === 0) return undefined;
      return this.get(id);
    } catch (err) {
      if (isUniqueViolation(err)) throw new DuplicateNameError();
      throw err;
    }
  }

  delete(id: number): boolean {
    return this.db.prepare("DELETE FROM members WHERE id = ?").run(id).changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
