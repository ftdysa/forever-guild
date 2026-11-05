import type Database from "better-sqlite3";

export type MilestoneKind = "level" | "skill" | "pvp_rank";
export type MilestoneSource = "observed" | "achievement" | "before_tracking" | "before_joining";

// One character's state on one UTC day. Armory fields are null (skills {}) until first read.
export interface Snapshot {
  name: string;
  day: string;
  classId: string;
  race: string | null;
  level: number;
  pvpRank: number | null;
  honorableKills: number | null;
  skills: Record<string, number>;
}

// Fields a sync pass knows. Omit the rest (don't pass undefined): they carry forward.
export type SnapshotPatch = Partial<Omit<Snapshot, "name" | "day">>;

export interface Milestone {
  name: string;
  kind: MilestoneKind;
  key: string;
  classId: string;
  race: string | null;
  // null when we don't know when it happened (before_tracking / before_joining).
  reachedAt: string | null;
  source: MilestoneSource;
  announced: boolean;
}

export type NewMilestone = Omit<Milestone, "announced">;

export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

// Keyed by character name, not member id: history and firsts outlive leaving the guild.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS member_snapshots (
  character_name TEXT NOT NULL COLLATE NOCASE,
  day TEXT NOT NULL,
  class TEXT NOT NULL,
  race TEXT,
  level INTEGER NOT NULL,
  pvp_rank INTEGER,
  honorable_kills INTEGER,
  skills TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (character_name, day)
);
CREATE TABLE IF NOT EXISTS milestones (
  character_name TEXT NOT NULL COLLATE NOCASE,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  class TEXT NOT NULL,
  race TEXT,
  reached_at TEXT,
  source TEXT NOT NULL,
  announced INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (character_name, kind, key)
);`;

interface SnapshotRow {
  character_name: string;
  day: string;
  class: string;
  race: string | null;
  level: number;
  pvp_rank: number | null;
  honorable_kills: number | null;
  skills: string;
}

interface MilestoneRow {
  character_name: string;
  kind: MilestoneKind;
  key: string;
  class: string;
  race: string | null;
  reached_at: string | null;
  source: MilestoneSource;
  announced: number;
}

const toSnapshot = (r: SnapshotRow): Snapshot => ({
  name: r.character_name,
  day: r.day,
  classId: r.class,
  race: r.race,
  level: r.level,
  pvpRank: r.pvp_rank,
  honorableKills: r.honorable_kills,
  skills: JSON.parse(r.skills) as Record<string, number>,
});

const toMilestone = (r: MilestoneRow): Milestone => ({
  name: r.character_name,
  kind: r.kind,
  key: r.key,
  classId: r.class,
  race: r.race,
  reachedAt: r.reached_at,
  source: r.source,
  announced: r.announced === 1,
});

export class ProgressStore {
  constructor(private db: Database.Database) {
    db.exec(SCHEMA);
  }

  // Merges `patch` into the character's row for `day`. Fields the patch omits keep today's value,
  // or else the most recent earlier day's, so a roster-only write doesn't erase armory data.
  upsertSnapshot(name: string, day: string, patch: SnapshotPatch): void {
    const base = this.get(name, day) ?? this.latestBefore(name, day);
    const row: Snapshot = {
      classId: "",
      race: null,
      level: 0,
      pvpRank: null,
      honorableKills: null,
      skills: {},
      ...base,
      ...patch,
      name: base?.name ?? name,
      day,
    };
    if (!row.classId) throw new Error(`no class for ${name}`);
    this.db
      .prepare(
        `INSERT INTO member_snapshots (character_name, day, class, race, level, pvp_rank, honorable_kills, skills)
         VALUES (@name, @day, @classId, @race, @level, @pvpRank, @honorableKills, @skills)
         ON CONFLICT (character_name, day) DO UPDATE SET class = excluded.class, race = excluded.race,
           level = excluded.level, pvp_rank = excluded.pvp_rank, honorable_kills = excluded.honorable_kills,
           skills = excluded.skills`,
      )
      .run({ ...row, skills: JSON.stringify(row.skills) });
  }

  upsertSnapshots(day: string, rows: { name: string; patch: SnapshotPatch }[]): void {
    this.db.transaction(() => {
      for (const r of rows) this.upsertSnapshot(r.name, day, r.patch);
    })();
  }

  get(name: string, day: string): Snapshot | null {
    const r = this.db.prepare("SELECT * FROM member_snapshots WHERE character_name = ? AND day = ?").get(name, day) as SnapshotRow | undefined;
    return r ? toSnapshot(r) : null;
  }

  // The character's most recent row from a day before `day`.
  latestBefore(name: string, day: string): Snapshot | null {
    const r = this.db
      .prepare("SELECT * FROM member_snapshots WHERE character_name = ? AND day < ? ORDER BY day DESC LIMIT 1")
      .get(name, day) as SnapshotRow | undefined;
    return r ? toSnapshot(r) : null;
  }

  // The character's most recent row from a day before `day` whose level was under `level`.
  latestBelowLevel(name: string, day: string, level: number): Snapshot | null {
    const r = this.db
      .prepare("SELECT * FROM member_snapshots WHERE character_name = ? AND day < ? AND level < ? ORDER BY day DESC LIMIT 1")
      .get(name, day, level) as SnapshotRow | undefined;
    return r ? toSnapshot(r) : null;
  }

  // The character's earliest row from a day after `afterDay` whose level was at least `level`.
  firstAtOrAbove(name: string, afterDay: string, level: number): Snapshot | null {
    const r = this.db
      .prepare("SELECT * FROM member_snapshots WHERE character_name = ? AND day > ? AND level >= ? ORDER BY day LIMIT 1")
      .get(name, afterDay, level) as SnapshotRow | undefined;
    return r ? toSnapshot(r) : null;
  }

  firstDay(name: string): string | null {
    const r = this.db.prepare("SELECT MIN(day) AS day FROM member_snapshots WHERE character_name = ?").get(name) as { day: string | null };
    return r.day;
  }

  // The day tracking began: the earliest snapshot of anyone.
  trackingSince(): string | null {
    return (this.db.prepare("SELECT MIN(day) AS day FROM member_snapshots").get() as { day: string | null }).day;
  }

  snapshots(): Snapshot[] {
    const rows = this.db.prepare("SELECT * FROM member_snapshots ORDER BY character_name COLLATE NOCASE, day").all() as SnapshotRow[];
    return rows.map(toSnapshot);
  }

  milestones(): Milestone[] {
    const rows = this.db.prepare("SELECT * FROM milestones ORDER BY character_name COLLATE NOCASE, kind, key").all() as MilestoneRow[];
    return rows.map(toMilestone);
  }

  milestonesFor(name: string): Milestone[] {
    const rows = this.db.prepare("SELECT * FROM milestones WHERE character_name = ? ORDER BY kind, key").all(name) as MilestoneRow[];
    return rows.map(toMilestone);
  }

  // false when the character already has this milestone (the first record wins).
  addMilestone(m: NewMilestone): boolean {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO milestones (character_name, kind, key, class, race, reached_at, source)
         VALUES (@name, @kind, @key, @classId, @race, @reachedAt, @source)`,
      )
      .run(m);
    return info.changes === 1;
  }

  markAnnounced(name: string, kind: MilestoneKind, key: string): void {
    this.db.prepare("UPDATE milestones SET announced = 1 WHERE character_name = ? AND kind = ? AND key = ?").run(name, kind, key);
  }

  wipe(): { snapshots: number; milestones: number } {
    return this.db.transaction(() => ({
      snapshots: this.db.prepare("DELETE FROM member_snapshots").run().changes,
      milestones: this.db.prepare("DELETE FROM milestones").run().changes,
    }))();
  }
}
