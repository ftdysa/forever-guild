# Level Race, Guild Firsts and PvP Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record daily level/skill/PvP snapshots and guild-first milestones during the guild sync, and show them on a new Progress tab (level race line chart, guild firsts board, PvP rank tracker), announcing new firsts on Discord.

**Architecture:** A `ProgressStore` (two SQLite tables) is written by a `ProgressRecorder` that the existing `GuildSync` calls after the roster pass and after each armory refresh. Pure modules decide which milestones were crossed (`milestones.ts`) and shape the API response (`progress-report.ts`). The browser gets one `GET /api/progress` payload and renders it with hand-drawn SVG in `public/progress.js`.

**Tech Stack:** Node ≥20, TypeScript (ESM), Fastify 5, better-sqlite3, `node:test` via `tsx`, vanilla browser JS modules.

**Spec:** `docs/superpowers/specs/2026-11-05-level-race-design.md`

## Global Constraints

- Tests: `npm test` (`NODE_ENV=test node --import tsx --test test/*.test.ts`); a single file: `NODE_ENV=test node --import tsx --test test/<file>.test.ts`. Also `npm run lint` and `npm run typecheck` must pass at the end of every task.
- CSP is `script-src 'self'` and no `'unsafe-inline'` styles: no chart libraries, no `style="..."` attributes in markup (SVG presentation attributes such as `stroke="#C69B6D"` are fine; element `.style.x =` through the DOM is fine).
- All browser markup goes through the app's `esc()` for any data-derived text or attribute.
- Days are UTC `YYYY-MM-DD`; timestamps are ISO strings from `Date#toISOString()` (so string comparison orders them).
- Thresholds: level 60; skill 300; PvP ranks 1–14.
- Milestone `source` values: `observed`, `achievement`, `before_tracking`, `before_joining`. Milestone `kind` values: `level`, `skill`, `pvp_rank`.
- Snapshots and milestones are keyed by character name (case-insensitive), never by member id, and are never deleted when a member leaves.
- Discord is best-effort and never throws; only `observed` milestones are ever announced.
- Per the user's CLAUDE.md: after writing code in each task, run the code-simplifier agent on the modified files before running the final verification for that task.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File Structure

| File | Status | Responsibility |
|------|--------|----------------|
| `src/progress-store.ts` | create | `member_snapshots` and `milestones` tables; upsert with carry-forward; queries; wipe |
| `src/milestones.ts` | create | Pure: which milestones a character meets, how each is sourced/dated, firsts per category, claim labels |
| `src/armory.ts` | modify | Map Legacy achievements to milestones; `CharacterInfo.milestoneAchievements`; cache key bumps |
| `src/discord.ts` | modify | `buildFirstsEmbed`, `DiscordNotifier.guildFirsts`, shared `send` |
| `src/progress.ts` | create | `ProgressRecorder`: writes snapshots, records milestones, announces firsts |
| `src/guild-sync.ts` | modify | Call the recorder after the roster pass and each armory refresh |
| `src/progress-report.ts` | create | Pure: snapshots + milestones → `/api/progress` payload |
| `src/routes/progress.ts` | create | `GET /api/progress` |
| `src/app.ts` | modify | Construct store/recorder, decorate `progress`, register route |
| `src/reset-data.ts` | modify | Also wipe progress tables |
| `public/progress.js` | create | Pure chart/card/table models + DOM rendering for the Progress tab |
| `public/index.html`, `public/app.js`, `public/style.css` | modify | Tab, panel, wiring, styles |
| `README.md` | modify | API row + "Progress" section |
| `test/progress-store.test.ts`, `test/milestones.test.ts`, `test/progress-recorder.test.ts`, `test/progress-report.test.ts`, `test/progress-api.test.ts`, `test/progress-ui.test.ts` | create | Tests |
| `test/armory.test.ts`, `test/discord.test.ts`, `test/guild-sync.test.ts` | modify | Tests |

---

### Task 1: ProgressStore

**Files:**
- Create: `src/progress-store.ts`
- Modify: `src/reset-data.ts`
- Test: `test/progress-store.test.ts`

**Interfaces:**
- Produces:
  - `type MilestoneKind = "level" | "skill" | "pvp_rank"`
  - `type MilestoneSource = "observed" | "achievement" | "before_tracking" | "before_joining"`
  - `interface Snapshot { name: string; day: string; classId: string; race: string | null; level: number; pvpRank: number | null; honorableKills: number | null; skills: Record<string, number> }`
  - `type SnapshotPatch = Partial<Omit<Snapshot, "name" | "day">>` (omit unknown fields; never pass `undefined` explicitly)
  - `interface Milestone { name: string; kind: MilestoneKind; key: string; classId: string; race: string | null; reachedAt: string | null; source: MilestoneSource; announced: boolean }`
  - `type NewMilestone = Omit<Milestone, "announced">`
  - `utcDay(ms: number): string`
  - `class ProgressStore` with `upsertSnapshot(name, day, patch): void`, `upsertSnapshots(day, rows: { name: string; patch: SnapshotPatch }[]): void`, `get(name, day): Snapshot | null`, `latestBefore(name, day): Snapshot | null`, `firstDay(name): string | null`, `trackingSince(): string | null`, `snapshots(): Snapshot[]` (ordered by name NOCASE, then day), `milestones(): Milestone[]`, `milestonesFor(name): Milestone[]`, `addMilestone(m: NewMilestone): boolean`, `markAnnounced(name, kind, key): void`, `wipe(): { snapshots: number; milestones: number }`

- [ ] **Step 1: Write the failing test**

Create `test/progress-store.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.js";
import { ProgressStore, utcDay, type NewMilestone } from "../src/progress-store.js";

const fresh = () => new ProgressStore(openDatabase(":memory:"));

test("utcDay formats a UTC date", () => {
  assert.equal(utcDay(Date.UTC(2026, 10, 5, 23, 59)), "2026-11-05");
});

test("an empty store has no tracking start and no rows", () => {
  const s = fresh();
  assert.equal(s.trackingSince(), null);
  assert.equal(s.firstDay("Grom"), null);
  assert.equal(s.latestBefore("Grom", "2026-11-05"), null);
  assert.deepEqual(s.snapshots(), []);
  assert.deepEqual(s.milestones(), []);
});

test("upsert inserts, merges same-day writes, and carries unknown fields forward from earlier days", () => {
  const s = fresh();
  s.upsertSnapshot("Grom", "2026-11-05", { classId: "warrior", level: 40 });
  s.upsertSnapshot("Grom", "2026-11-05", { race: "Orc", pvpRank: 2, honorableKills: 30, skills: { mining: 150 } });
  assert.deepEqual(s.get("grom", "2026-11-05"), {
    name: "Grom", day: "2026-11-05", classId: "warrior", race: "Orc", level: 40, pvpRank: 2, honorableKills: 30, skills: { mining: 150 },
  });
  s.upsertSnapshot("Grom", "2026-11-07", { classId: "warrior", level: 42 });
  assert.deepEqual(s.get("Grom", "2026-11-07"), {
    name: "Grom", day: "2026-11-07", classId: "warrior", race: "Orc", level: 42, pvpRank: 2, honorableKills: 30, skills: { mining: 150 },
  });
  assert.equal(s.latestBefore("Grom", "2026-11-07")?.day, "2026-11-05");
  assert.equal(s.latestBefore("Grom", "2026-11-05"), null);
  assert.equal(s.firstDay("GROM"), "2026-11-05");
  assert.equal(s.trackingSince(), "2026-11-05");
});

test("a first row without a class is rejected", () => {
  assert.throws(() => fresh().upsertSnapshot("Grom", "2026-11-05", { level: 3 }), /no class/);
});

test("upsertSnapshots writes many rows for one day; snapshots() orders by name then day", () => {
  const s = fresh();
  s.upsertSnapshots("2026-11-06", [
    { name: "zed", patch: { classId: "mage", level: 5 } },
    { name: "Arg", patch: { classId: "rogue", level: 9 } },
  ]);
  s.upsertSnapshot("Arg", "2026-11-05", { classId: "rogue", level: 8 });
  assert.deepEqual(s.snapshots().map((r) => [r.name, r.day, r.level]), [
    ["Arg", "2026-11-05", 8],
    ["Arg", "2026-11-06", 9],
    ["zed", "2026-11-06", 5],
  ]);
});

const sixty: NewMilestone = { name: "Grom", kind: "level", key: "60", classId: "warrior", race: "Orc", reachedAt: "2026-11-05T10:00:00.000Z", source: "observed" };

test("milestones are recorded once per character (any case), and can be marked announced", () => {
  const s = fresh();
  assert.equal(s.addMilestone(sixty), true);
  assert.equal(s.addMilestone({ ...sixty, name: "GROM", source: "before_tracking", reachedAt: null }), false);
  assert.deepEqual(s.milestonesFor("grom"), [{ ...sixty, announced: false }]);
  s.markAnnounced("grom", "level", "60");
  assert.deepEqual(s.milestones(), [{ ...sixty, announced: true }]);
});

test("wipe clears both tables", () => {
  const s = fresh();
  s.upsertSnapshot("Grom", "2026-11-05", { classId: "warrior", level: 40 });
  s.addMilestone(sixty);
  assert.deepEqual(s.wipe(), { snapshots: 1, milestones: 1 });
  assert.deepEqual(s.snapshots(), []);
  assert.deepEqual(s.milestones(), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_ENV=test node --import tsx --test test/progress-store.test.ts`
Expected: FAIL — `Cannot find module '../src/progress-store.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/progress-store.ts`:

```ts
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
```

- [ ] **Step 4: Wire into reset-data**

Replace the body of `src/reset-data.ts` after the `--yes` check:

```ts
import { ArmoryCache, MemberStore, openDatabase, wipeGuildData } from "./db.js";
import { ProgressStore } from "./progress-store.js";

// Wipes all members, cached armory data and progress history. Usage: node dist/reset-data.js --yes
const dbPath = process.env.DB_PATH || "./data/roster.db";
if (!process.argv.includes("--yes")) {
  console.error(`This permanently deletes every member, all cached armory data and all progress history in ${dbPath}.`);
  console.error("Re-run with --yes to confirm.");
  process.exit(1);
}

const db = openDatabase(dbPath);
// Ensure the tables exist so a fresh database wipes cleanly.
new MemberStore(db);
new ArmoryCache(db);
const { members, cached } = wipeGuildData(db);
const { snapshots, milestones } = new ProgressStore(db).wipe();
db.close();
console.log(`Removed ${members} members, ${cached} cached armory entries, ${snapshots} snapshots and ${milestones} milestones from ${dbPath}.`);
```

- [ ] **Step 5: Run tests, lint, typecheck**

Run: `NODE_ENV=test node --import tsx --test test/progress-store.test.ts && npm run lint && npm run typecheck`
Expected: all 7 tests PASS; lint and typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/progress-store.ts src/reset-data.ts test/progress-store.test.ts
git commit -m "feat: progress store for daily snapshots and milestones

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Milestone detection and firsts (pure)

**Files:**
- Create: `src/milestones.ts`
- Test: `test/milestones.test.ts`

**Interfaces:**
- Consumes: `Milestone`, `MilestoneKind`, `NewMilestone`, `Snapshot` from `src/progress-store.ts`; `CLASSES`, `PROFESSIONS`, `findClass` from `src/game-data.ts`.
- Produces:
  - `MAX_LEVEL = 60`, `MAX_SKILL = 300`, `PVP_RANKS = 14`
  - `interface MilestoneDef { kind: MilestoneKind; key: string; classId: string | null }`
  - `interface AchievementMilestone extends MilestoneDef { completedAt: string }`
  - `interface CharacterState { classId: string; race: string | null; level: number; skills: Record<string, number>; pvpRank: number | null }`
  - `milestonesMet(s: CharacterState): { kind: MilestoneKind; key: string }[]`
  - `interface DetectInput { name: string; state: CharacterState; prior: Snapshot | null; launchMember: boolean; existing: Pick<Milestone, "kind" | "key">[]; achievements: AchievementMilestone[]; lastLogin: string | null; now: string }`
  - `detectMilestones(i: DetectInput): NewMilestone[]`
  - `interface Holder { name: string; classId: string; current: boolean; reachedAt: string; source: "observed" | "achievement" }`
  - `interface Category { holders: Holder[]; atLaunch: string[] }`
  - `interface Firsts { overall60: Category; byClass: Record<string, Category>; byRace: Record<string, Category>; bySkill: Record<string, Category>; byPvpRank: Record<string, Category> }`
  - `computeFirsts(all: Milestone[], currentNames?: string[], races?: string[]): Firsts`
  - `claimedFirsts(m: Pick<Milestone, "name" | "kind" | "key" | "classId" | "race">, firsts: Firsts): string[]`

- [ ] **Step 1: Write the failing test**

Create `test/milestones.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  claimedFirsts, computeFirsts, detectMilestones, milestonesMet,
  type AchievementMilestone, type CharacterState, type DetectInput,
} from "../src/milestones.js";
import type { Milestone, Snapshot } from "../src/progress-store.js";

const NOW = "2026-11-10T12:00:00.000Z";
const LOGIN = "2026-11-10T08:00:00.000Z";
const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  name: "Grom", day: "2026-11-09", classId: "warrior", race: "Orc", level: 59, pvpRank: 0, honorableKills: 0, skills: {}, ...over,
});
const state = (over: Partial<CharacterState> = {}): CharacterState => ({ classId: "warrior", race: "Orc", level: 60, skills: {}, pvpRank: 0, ...over });
const input = (over: Partial<DetectInput> = {}): DetectInput => ({
  name: "Grom", state: state(), prior: snap(), launchMember: false, existing: [], achievements: [], lastLogin: LOGIN, now: NOW, ...over,
});
const brief = (ms: { kind: string; key: string; source: string; reachedAt: string | null }[]) => ms.map((m) => [m.kind, m.key, m.source, m.reachedAt]);
const ranks = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: "pvp_rank" as const, key: String(i + 1) }));

test("milestonesMet: level 60, 300 skill per profession, every PvP rank up to the current one", () => {
  assert.deepEqual(
    milestonesMet(state({ classId: "mage", race: "Gnome", skills: { tailoring: 300, enchanting: 299 }, pvpRank: 3 })).map((m) => `${m.kind}:${m.key}`),
    ["level:60", "skill:tailoring", "pvp_rank:1", "pvp_rank:2", "pvp_rank:3"],
  );
  assert.deepEqual(milestonesMet(state({ level: 59, race: null, pvpRank: null })), []);
});

test("a crossing since an earlier day is observed and dated by last login", () => {
  assert.deepEqual(brief(detectMilestones(input())), [["level", "60", "observed", LOGIN]]);
  // the stored row keeps the character's details
  const [m] = detectMilestones(input());
  assert.deepEqual([m.name, m.classId, m.race], ["Grom", "warrior", "Orc"]);
});

test("observed falls back to now when last login is missing, before the earlier snapshot, or in the future", () => {
  for (const lastLogin of [null, "2026-11-08T23:00:00.000Z", "2026-11-11T00:00:00.000Z"]) {
    assert.deepEqual(brief(detectMilestones(input({ lastLogin }))), [["level", "60", "observed", NOW]]);
  }
});

test("milestones already recorded are not recorded again", () => {
  assert.deepEqual(detectMilestones(input({ existing: [{ kind: "level", key: "60" }] })), []);
});

test("skills and PvP are observed only when the earlier snapshot had armory data", () => {
  const s = state({ level: 59, skills: { mining: 300 }, pvpRank: 2 });
  assert.deepEqual(brief(detectMilestones(input({ state: s, prior: snap({ skills: { mining: 290 }, pvpRank: 1 }), existing: ranks(1) }))), [
    ["skill", "mining", "observed", LOGIN],
    ["pvp_rank", "2", "observed", LOGIN],
  ]);
  // race null: the armory was never read, so the earlier values are unknown
  assert.deepEqual(brief(detectMilestones(input({ state: s, prior: snap({ race: null, pvpRank: null }), existing: ranks(1) }))), [
    ["skill", "mining", "before_joining", null],
    ["pvp_rank", "2", "before_joining", null],
  ]);
});

test("a PvP jump records every rank passed; a later drop removes nothing", () => {
  const jump = detectMilestones(input({ state: state({ level: 59, pvpRank: 7 }), prior: snap({ pvpRank: 4 }), existing: ranks(4) }));
  assert.deepEqual(brief(jump), [["pvp_rank", "5", "observed", LOGIN], ["pvp_rank", "6", "observed", LOGIN], ["pvp_rank", "7", "observed", LOGIN]]);
  assert.deepEqual(detectMilestones(input({ state: state({ level: 59, pvpRank: 5 }), prior: snap({ pvpRank: 7 }), existing: ranks(7) })), []);
});

test("launch members use a matching achievement's date, else before_tracking", () => {
  const achievements: AchievementMilestone[] = [
    { kind: "level", key: "60", classId: "warrior", completedAt: "2026-10-01T00:00:00.000Z" },
    { kind: "pvp_rank", key: "3", classId: null, completedAt: "2026-10-02T00:00:00.000Z" },
  ];
  assert.deepEqual(brief(detectMilestones(input({ state: state({ pvpRank: 3 }), prior: null, launchMember: true, achievements }))), [
    ["level", "60", "achievement", "2026-10-01T00:00:00.000Z"],
    ["pvp_rank", "1", "before_tracking", null],
    ["pvp_rank", "2", "before_tracking", null],
    ["pvp_rank", "3", "achievement", "2026-10-02T00:00:00.000Z"],
  ]);
});

test("a launch member already at 60 on an earlier day (armory failed then) still gets launch treatment", () => {
  assert.deepEqual(brief(detectMilestones(input({ prior: snap({ level: 60 }), launchMember: true }))), [["level", "60", "before_tracking", null]]);
});

test("an achievement for another class, or dated in the future, is not trusted", () => {
  for (const a of [
    { kind: "level", key: "60", classId: "druid", completedAt: "2026-10-01T00:00:00.000Z" },
    { kind: "level", key: "60", classId: "warrior", completedAt: "2026-12-01T00:00:00.000Z" },
  ] as AchievementMilestone[]) {
    assert.deepEqual(brief(detectMilestones(input({ prior: null, launchMember: true, achievements: [a] }))), [["level", "60", "before_tracking", null]]);
  }
});

test("newcomers already past a milestone are before_joining", () => {
  assert.deepEqual(brief(detectMilestones(input({ prior: null }))), [["level", "60", "before_joining", null]]);
});

const ms = (name: string, kind: Milestone["kind"], key: string, source: Milestone["source"], reachedAt: string | null, over: Partial<Milestone> = {}): Milestone => ({
  name, kind, key, classId: "warrior", race: "Orc", source, reachedAt, announced: false, ...over,
});

test("firsts: earliest dated holder first, ties by name, three at most; launch rows apart; newcomers excluded", () => {
  const all = [
    ms("Zug", "level", "60", "observed", "2026-11-05T00:00:00.000Z"),
    ms("Grom", "level", "60", "achievement", "2026-10-01T00:00:00.000Z"),
    ms("Arg", "level", "60", "observed", "2026-11-05T00:00:00.000Z"),
    ms("Old", "level", "60", "before_tracking", null),
    ms("Late", "level", "60", "before_joining", null),
    ms("Fourth", "level", "60", "observed", "2026-11-06T00:00:00.000Z"),
  ];
  const f = computeFirsts(all, ["grom", "ARG", "Old"]);
  assert.deepEqual(f.overall60.holders.map((h) => [h.name, h.current, h.source]), [
    ["Grom", true, "achievement"],
    ["Arg", true, "observed"],
    ["Zug", false, "observed"],
  ]);
  assert.deepEqual(f.overall60.atLaunch, ["Old"]);
  assert.deepEqual(f.byClass.warrior.holders.map((h) => h.name), ["Grom", "Arg", "Zug"]);
  assert.deepEqual(f.byClass.mage, { holders: [], atLaunch: [] });
  assert.deepEqual(Object.keys(f.byRace), ["Orc"]);
  assert.equal(Object.keys(f.bySkill).length, 12);
  assert.deepEqual(Object.keys(f.byPvpRank), Array.from({ length: 14 }, (_, i) => String(i + 1)));
});

test("firsts: races passed in appear even when unclaimed, sorted", () => {
  assert.deepEqual(computeFirsts([], [], ["Troll", "Gnome"]).byRace, { Gnome: { holders: [], atLaunch: [] }, Troll: { holders: [], atLaunch: [] } });
});

test("claimedFirsts lists only the categories the milestone now leads", () => {
  const grom = ms("Grom", "level", "60", "observed", "2026-11-05T00:00:00.000Z", { classId: "shaman" });
  assert.deepEqual(claimedFirsts(grom, computeFirsts([ms("Early", "level", "60", "observed", "2026-11-01T00:00:00.000Z"), grom])), [
    "First Shaman to reach level 60",
  ]);
  assert.deepEqual(claimedFirsts(grom, computeFirsts([grom])), [
    "First to reach level 60",
    "First Shaman to reach level 60",
    "First Orc to reach level 60",
  ]);
  const tailor = ms("Grom", "skill", "tailoring", "observed", "2026-11-05T00:00:00.000Z");
  assert.deepEqual(claimedFirsts(tailor, computeFirsts([tailor])), ["First to reach 300 Tailoring"]);
  const rank = ms("Grom", "pvp_rank", "7", "observed", "2026-11-05T00:00:00.000Z");
  assert.deepEqual(claimedFirsts(rank, computeFirsts([rank])), ["First to reach PvP rank 7"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_ENV=test node --import tsx --test test/milestones.test.ts`
Expected: FAIL — `Cannot find module '../src/milestones.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/milestones.ts`:

```ts
import { CLASSES, findClass, PROFESSIONS } from "./game-data.js";
import type { Milestone, MilestoneKind, NewMilestone, Snapshot } from "./progress-store.js";

export const MAX_LEVEL = 60;
export const MAX_SKILL = 300;
export const PVP_RANKS = 14;
const HOLDERS = 3;
const LEVEL_KEY = String(MAX_LEVEL);

// What a milestone achievement proves. classId is set for "Master <Class>" (level 60 on that class).
export interface MilestoneDef {
  kind: MilestoneKind;
  key: string;
  classId: string | null;
}

// A completed milestone achievement. Account-wide: it may have been earned on another character.
export interface AchievementMilestone extends MilestoneDef {
  completedAt: string;
}

export interface CharacterState {
  classId: string;
  race: string | null;
  level: number;
  skills: Record<string, number>;
  pvpRank: number | null;
}

export function milestonesMet(s: CharacterState): { kind: MilestoneKind; key: string }[] {
  const out: { kind: MilestoneKind; key: string }[] = [];
  if (s.level >= MAX_LEVEL) out.push({ kind: "level", key: LEVEL_KEY });
  for (const p of PROFESSIONS) if ((s.skills[p.id] ?? 0) >= MAX_SKILL) out.push({ kind: "skill", key: p.id });
  for (let r = 1; r <= Math.min(s.pvpRank ?? 0, PVP_RANKS); r++) out.push({ kind: "pvp_rank", key: String(r) });
  return out;
}

export interface DetectInput {
  name: string;
  state: CharacterState;
  // The character's latest snapshot from an earlier day (not today's).
  prior: Snapshot | null;
  // On the roster when tracking began (first snapshot day == tracking start).
  launchMember: boolean;
  existing: Pick<Milestone, "kind" | "key">[];
  achievements: AchievementMilestone[];
  lastLogin: string | null;
  now: string;
}

// True when the earlier snapshot shows the character below this milestone. Skills and PvP are
// only known once the armory has been read (race is set by that read).
function wasBelow(kind: MilestoneKind, key: string, prior: Snapshot | null): boolean {
  if (!prior) return false;
  if (kind === "level") return prior.level < MAX_LEVEL;
  if (prior.race === null) return false;
  if (kind === "skill") return (prior.skills[key] ?? 0) < MAX_SKILL;
  return (prior.pvpRank ?? 0) < Number(key);
}

// Data only changes when someone plays, so the last login is the session it happened in. Ignore it
// if it predates the earlier snapshot or is in the future.
function observedAt(i: DetectInput): string {
  const ok = i.lastLogin && i.prior && i.lastLogin >= `${i.prior.day}T00:00:00.000Z` && i.lastLogin <= i.now;
  return ok ? (i.lastLogin as string) : i.now;
}

// Achievements are account-wide, so a date is only trusted when this character meets the
// milestone now (true for everything detectMilestones looks at) and, for "Master <Class>",
// plays that class.
function achievedAt(kind: MilestoneKind, key: string, i: DetectInput): string | null {
  const a = i.achievements.find((x) => x.kind === kind && x.key === key && (x.classId === null || x.classId === i.state.classId));
  return a && a.completedAt <= i.now ? a.completedAt : null;
}

// Milestones the character meets now and has no record of yet, each with its source and date.
export function detectMilestones(i: DetectInput): NewMilestone[] {
  const have = new Set(i.existing.map((m) => `${m.kind}:${m.key}`));
  return milestonesMet(i.state)
    .filter((m) => !have.has(`${m.kind}:${m.key}`))
    .map(({ kind, key }): NewMilestone => {
      const base = { name: i.name, kind, key, classId: i.state.classId, race: i.state.race };
      if (wasBelow(kind, key, i.prior)) return { ...base, source: "observed", reachedAt: observedAt(i) };
      if (!i.launchMember) return { ...base, source: "before_joining", reachedAt: null };
      const at = achievedAt(kind, key, i);
      return at ? { ...base, source: "achievement", reachedAt: at } : { ...base, source: "before_tracking", reachedAt: null };
    });
}

export interface Holder {
  name: string;
  classId: string;
  current: boolean;
  reachedAt: string;
  source: "observed" | "achievement";
}

export interface Category {
  // Earliest first, at most three.
  holders: Holder[];
  // Already past it when tracking began, date unknown.
  atLaunch: string[];
}

export interface Firsts {
  overall60: Category;
  byClass: Record<string, Category>;
  byRace: Record<string, Category>;
  bySkill: Record<string, Category>;
  byPvpRank: Record<string, Category>;
}

const byName = (a: string, b: string) => a.localeCompare(b);

function category(rows: Milestone[], current: Set<string>): Category {
  const dated = rows
    .filter((m) => m.reachedAt !== null && (m.source === "observed" || m.source === "achievement"))
    .sort((a, b) => (a.reachedAt as string).localeCompare(b.reachedAt as string) || byName(a.name, b.name));
  return {
    holders: dated.slice(0, HOLDERS).map((m) => ({
      name: m.name,
      classId: m.classId,
      current: current.has(m.name.toLowerCase()),
      reachedAt: m.reachedAt as string,
      source: m.source as Holder["source"],
    })),
    atLaunch: rows.filter((m) => m.source === "before_tracking").map((m) => m.name).sort(byName),
  };
}

const isSixty = (m: Pick<Milestone, "kind" | "key">) => m.kind === "level" && m.key === LEVEL_KEY;

// Guild firsts per category. before_joining rows (arrived already past it) never count.
// `races`: races to list even when unclaimed (e.g. every race seen in a snapshot).
export function computeFirsts(all: Milestone[], currentNames: string[] = [], races: string[] = []): Firsts {
  const current = new Set(currentNames.map((n) => n.toLowerCase()));
  const of = (pred: (m: Milestone) => boolean) => category(all.filter(pred), current);
  const sixties = all.filter(isSixty);
  const raceKeys = [...new Set([...races, ...sixties.map((m) => m.race).filter((r): r is string => !!r)])].sort(byName);
  return {
    overall60: of(isSixty),
    byClass: Object.fromEntries(CLASSES.map((c) => [c.id, of((m) => isSixty(m) && m.classId === c.id)])),
    byRace: Object.fromEntries(raceKeys.map((r) => [r, of((m) => isSixty(m) && m.race === r)])),
    bySkill: Object.fromEntries(PROFESSIONS.map((p) => [p.id, of((m) => m.kind === "skill" && m.key === p.id)])),
    byPvpRank: Object.fromEntries(
      Array.from({ length: PVP_RANKS }, (_, i) => String(i + 1)).map((r) => [r, of((m) => m.kind === "pvp_rank" && m.key === r)]),
    ),
  };
}

// Labels for the categories `m` now leads, for the Discord announcement.
export function claimedFirsts(m: Pick<Milestone, "name" | "kind" | "key" | "classId" | "race">, firsts: Firsts): string[] {
  const leads = (c: Category | undefined) => c?.holders[0]?.name.toLowerCase() === m.name.toLowerCase();
  if (m.kind === "level") {
    return [
      leads(firsts.overall60) && "First to reach level 60",
      leads(firsts.byClass[m.classId]) && `First ${findClass(m.classId)?.name ?? m.classId} to reach level 60`,
      m.race && leads(firsts.byRace[m.race]) && `First ${m.race} to reach level 60`,
    ].filter((s): s is string => !!s);
  }
  if (m.kind === "skill") {
    const name = PROFESSIONS.find((p) => p.id === m.key)?.name ?? m.key;
    return leads(firsts.bySkill[m.key]) ? [`First to reach 300 ${name}`] : [];
  }
  return leads(firsts.byPvpRank[m.key]) ? [`First to reach PvP rank ${m.key}`] : [];
}
```

- [ ] **Step 4: Run tests, lint, typecheck**

Run: `NODE_ENV=test node --import tsx --test test/milestones.test.ts && npm run lint && npm run typecheck`
Expected: all 13 tests PASS; lint and typecheck clean. (`findClass` is already exported from `src/game-data.ts`; `src/discord.ts` imports it.)

- [ ] **Step 5: Commit**

```bash
git add src/milestones.ts test/milestones.test.ts
git commit -m "feat: milestone detection and guild firsts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Milestone achievements from the armory

**Files:**
- Modify: `src/armory.ts` (imports; `CharacterInfo`; `LegacyDefs`; new `milestoneOf`, `achievedMilestones`; `legacyAchievements()` key `legacy:v2`; `character()` key `character:v7`; `loadCharacter()`)
- Test: `test/armory.test.ts`

**Interfaces:**
- Consumes: `MilestoneDef`, `AchievementMilestone` from `src/milestones.ts`.
- Produces:
  - `CharacterInfo.milestoneAchievements: AchievementMilestone[]` (`[]` outside Forever or when lookups fail)
  - `LegacyDefs.milestones: Record<number, MilestoneDef>`
  - `milestoneOf(name: string): MilestoneDef | null` (exported)

Verified names (static-forever-us, 2026-11-05): "Master Druid" ("Reach level 60 for the first time on a Druid"), "Artisan Alchemist" (300 skill), "Rank 3"…"Rank 14". Each exists twice (faction copies); all are Legacy (reward "Earn 1 Legacy Point."), so they are already in the Legacy scan.

- [ ] **Step 1: Write the failing tests**

Append to `test/armory.test.ts` (it already defines `setup`, `foreverFixture`, `foreverCfg`, `FOREVER`; add `milestoneOf` to the import from `../src/armory.js`):

```ts
test("milestoneOf maps Master <Class>, Artisan <Profession> and Rank <N>; ignores the rest", () => {
  assert.deepEqual(milestoneOf("Master Druid"), { kind: "level", key: "60", classId: "druid" });
  assert.deepEqual(milestoneOf("Artisan Leatherworker"), { kind: "skill", key: "leatherworking", classId: null });
  assert.deepEqual(milestoneOf("Rank 14"), { kind: "pvp_rank", key: "14", classId: null });
  for (const name of ["Master Spelunker", "Master of Alterac Valley", "Expert Tailor", "Rank 15", "Novice Mage"]) {
    assert.equal(milestoneOf(name), null, name);
  }
});

test("forever: completed milestone achievements come back with their dates", async () => {
  const routes = foreverFixture();
  Object.assign(routes, {
    "/data/wow/achievement-category/index": { categories: [{ id: 1 }] },
    "/data/wow/achievement-category/1": { achievements: [{ id: 400 }, { id: 401 }, { id: 402 }, { id: 403 }] },
    "/data/wow/achievement/400": { id: 400, name: "Master Mage", reward_description: "Earn 1 Legacy Point." },
    "/data/wow/achievement/401": { id: 401, name: "Artisan Tailor", reward_description: "Earn 1 Legacy Point." },
    "/data/wow/achievement/402": { id: 402, name: "Rank 7", reward_description: "Earn 1 Legacy Point." },
    "/data/wow/achievement/403": { id: 403, name: "Master Spelunker", reward_description: "Earn 1 Legacy Point." },
    [`${FOREVER}/achievements`]: {
      achievements: [
        { id: 400, completed_timestamp: Date.UTC(2026, 9, 1) },
        { id: 401 }, // in progress
        { id: 402, completed_timestamp: Date.UTC(2026, 9, 2) },
        { id: 403, completed_timestamp: Date.UTC(2026, 9, 3) },
      ],
    },
  });
  const { armory } = setup(routes, foreverCfg);
  assert.deepEqual((await armory.character("jaina"))?.milestoneAchievements, [
    { kind: "level", key: "60", classId: "mage", completedAt: "2026-10-01T00:00:00.000Z" },
    { kind: "pvp_rank", key: "7", classId: null, completedAt: "2026-10-02T00:00:00.000Z" },
  ]);
});

test("milestone achievements are empty when the lookup fails or outside Forever", async () => {
  assert.deepEqual((await setup(foreverFixture(), foreverCfg).armory.character("jaina"))?.milestoneAchievements, []);
  assert.deepEqual((await setup().armory.character("jaina"))?.milestoneAchievements, []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE_ENV=test node --import tsx --test test/armory.test.ts`
Expected: FAIL — `milestoneOf` is not exported / `milestoneAchievements` is undefined.

- [ ] **Step 3: Implement**

In `src/armory.ts`:

1. Imports — change the game-data import and add the milestones types:

```ts
import { CLASSES, findSpec, PROFESSIONS } from "./game-data.js";
import type { AchievementMilestone, MilestoneDef } from "./milestones.js";
```

2. In `interface CharacterInfo`, after `legacy`:

```ts
  // Forever only: completed level-60 / 300-skill / PvP-rank achievements (account-wide), for
  // backfilling guild firsts. [] elsewhere or when the lookup fails.
  milestoneAchievements: AchievementMilestone[];
```

3. Replace `LegacyDefs` and add the two helpers right after `legacyProgress`:

```ts
export interface LegacyDefs {
  ids: number[];
  total: number;
  // Legacy achievements that mark a guild-firsts milestone, by achievement id.
  milestones: Record<number, MilestoneDef>;
}

// "Artisan <Profession>" uses the crafter noun, not the profession name.
const ARTISAN: Record<string, string> = {
  Alchemist: "alchemy",
  Blacksmith: "blacksmithing",
  Enchanter: "enchanting",
  Engineer: "engineering",
  Leatherworker: "leatherworking",
  Tailor: "tailoring",
};

// The milestone a Legacy achievement proves: "Master <Class>" (level 60 on that class),
// "Artisan <Profession>" (300 skill) or "Rank <N>" (PvP rank N). null for anything else.
export function milestoneOf(name: string): MilestoneDef | null {
  const master = /^Master (\w+)$/.exec(name);
  if (master) {
    const cls = CLASSES.find((c) => c.name === master[1]);
    return cls ? { kind: "level", key: "60", classId: cls.id } : null;
  }
  const artisan = /^Artisan (\w+)$/.exec(name);
  if (artisan && ARTISAN[artisan[1]]) return { kind: "skill", key: ARTISAN[artisan[1]], classId: null };
  const rank = /^Rank (\d+)$/.exec(name);
  const n = rank ? Number(rank[1]) : 0;
  return n >= 1 && n <= 14 ? { kind: "pvp_rank", key: String(n), classId: null } : null;
}

export function achievedMilestones(defs: LegacyDefs, raw: RawAchievements): AchievementMilestone[] {
  return (raw.achievements ?? []).flatMap((a) => {
    const def = defs.milestones[a.id];
    return def && a.completed_timestamp ? [{ ...def, completedAt: new Date(a.completed_timestamp).toISOString() }] : [];
  });
}
```

4. In `legacyAchievements()`, bump the key to `` `${this.keyPrefix}:legacy:v2` `` and replace the `return` with:

```ts
      const milestones = Object.fromEntries(
        legacy.flatMap((d) => {
          const m = milestoneOf(d.name ?? "");
          return m ? [[d.id, m]] : [];
        }),
      );
      // Faction copies share a name, so distinct names count the challenges a character can earn.
      return { ids: legacy.map((d) => d.id), total: new Set(legacy.map((d) => d.name)).size, milestones };
```

5. In `character()`, bump the key comment and value (cached entries lack the new field, and an unchanged character's entry otherwise never refreshes):

```ts
    // Keyed by API path (realm or slug included). v4: path-based keys with Last-Modified; v5 added metadata; v6 added recipes; v7 added milestone achievements.
    const key = `${this.keyPrefix}:character:v7:${base}`;
```

6. In `loadCharacter()`'s returned object, after `legacy`:

```ts
      milestoneAchievements: legacyDefs && achievements ? achievedMilestones(legacyDefs, achievements) : [],
```

- [ ] **Step 4: Run tests, lint, typecheck**

Run: `NODE_ENV=test node --import tsx --test test/armory.test.ts && npm test && npm run lint && npm run typecheck`
Expected: PASS, including the existing Legacy test (its `legacy` result is unchanged). If any other test builds a `CharacterInfo` literal, typecheck will point at it: add `milestoneAchievements: []`.

- [ ] **Step 5: Commit**

```bash
git add src/armory.ts test/armory.test.ts
git commit -m "feat: read milestone achievements for guild-firsts backfill

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Discord guild-firsts embed

**Files:**
- Modify: `src/discord.ts`
- Test: `test/discord.test.ts`

**Interfaces:**
- Produces:
  - `Embed` gains `description?: string`
  - `interface FirstsWho { name: string; surname: string | null; classId: string }`
  - `buildFirstsEmbed(who: FirstsWho, claims: string[], at: string, siteUrl?: string): Embed`
  - `DiscordNotifier.guildFirsts(who: FirstsWho, claims: string[], at: string): Promise<void>` (never throws)

- [ ] **Step 1: Write the failing tests**

Append to `test/discord.test.ts` (add `buildFirstsEmbed` to the import):

```ts
test("guild-firsts embed lists each claim and links to the Progress tab", () => {
  const e = buildFirstsEmbed(
    { name: "Thrall", surname: "Durotan", classId: "shaman" },
    ["First to reach level 60", "First Orc to reach level 60"],
    "2026-11-10T08:00:00.000Z",
    "https://example.test/",
  );
  assert.equal(e.title, "Thrall Durotan claimed 2 guild firsts");
  assert.equal(e.description, "🏆 First to reach level 60\n🏆 First Orc to reach level 60");
  assert.equal(e.url, "https://example.test/#progress");
  assert.equal(e.color, 0x0070dd);
  assert.deepEqual(e.fields, []);
  assert.equal(e.timestamp, "2026-11-10T08:00:00.000Z");
  const one = buildFirstsEmbed({ name: "Grom", surname: null, classId: "warrior" }, ["First to reach PvP rank 1"], "2026-11-10T08:00:00.000Z");
  assert.equal(one.title, "Grom claimed a guild first");
  assert.equal("url" in one, false);
});

test("notifier posts guild firsts and swallows failures", async () => {
  const calls: RequestInit[] = [];
  const ok = (async (_url: string, init: RequestInit) => {
    calls.push(init);
    return new Response(null, { status: 204 });
  }) as unknown as FetchFn;
  const who = { name: "Grom", surname: null, classId: "warrior" };
  await new DiscordNotifier({ webhookUrl: HOOK }, fakeLog().log, ok).guildFirsts(who, ["First to reach level 60"], "2026-11-10T08:00:00.000Z");
  assert.deepEqual(JSON.parse(String(calls[0].body)).embeds, [buildFirstsEmbed(who, ["First to reach level 60"], "2026-11-10T08:00:00.000Z")]);
  const boom = (async () => {
    throw new Error("boom");
  }) as unknown as FetchFn;
  const { log, warnings } = fakeLog();
  await new DiscordNotifier({ webhookUrl: HOOK }, log, boom).guildFirsts(who, ["x"], "2026-11-10T08:00:00.000Z");
  assert.deepEqual(warnings[0][0], { error: "boom" });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE_ENV=test node --import tsx --test test/discord.test.ts`
Expected: FAIL — `buildFirstsEmbed` is not exported.

- [ ] **Step 3: Implement**

In `src/discord.ts`:

1. Add `description?: string;` to `interface Embed` after `url`.
2. Pull the colour logic into a helper and use it in `buildJoinEmbed` (`color: classColor(m.mainClass),`):

```ts
function classColor(classId: string): number {
  const hex = findClass(classId)?.color ?? "#C0C0C0";
  return parseInt((COLOR_OVERRIDES[hex] ?? hex).slice(1), 16);
}
```

(delete the `const hex = ...` line in `buildJoinEmbed`.)

3. Add after `buildJoinEmbed`:

```ts
export interface FirstsWho {
  name: string;
  surname: string | null;
  classId: string;
}

export function buildFirstsEmbed(who: FirstsWho, claims: string[], at: string, siteUrl?: string): Embed {
  const name = [who.name, who.surname].filter(Boolean).join(" ");
  return {
    title: claims.length === 1 ? `${name} claimed a guild first` : `${name} claimed ${claims.length} guild firsts`,
    ...(siteUrl ? { url: `${siteUrl.replace(/\/+$/, "")}/#progress` } : {}),
    description: claims.map((c) => `🏆 ${c}`).join("\n"),
    color: classColor(who.classId),
    fields: [],
    timestamp: at,
  };
}
```

4. Replace the body of `DiscordNotifier` with a shared `send`:

```ts
export class DiscordNotifier {
  constructor(
    private config: DiscordConfig,
    private log: FastifyBaseLogger,
    private fetchFn: FetchFn = fetch,
  ) {}

  memberJoined(m: Member): Promise<void> {
    return this.send(buildJoinEmbed(m, this.config.siteUrl));
  }

  guildFirsts(who: FirstsWho, claims: string[], at: string): Promise<void> {
    return this.send(buildFirstsEmbed(who, claims, at, this.config.siteUrl));
  }

  // Never throws: a lost announcement must not affect the API response. Logs never include the URL.
  private async send(embed: Embed): Promise<void> {
    try {
      const res = await this.fetchFn(this.config.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        this.log.warn({ status: res.status }, "discord webhook rejected");
        await res.body?.cancel();
      }
    } catch (err) {
      this.log.warn({ error: (err as Error).message }, "discord webhook failed");
    }
  }
}
```

- [ ] **Step 4: Run tests, lint, typecheck**

Run: `NODE_ENV=test node --import tsx --test test/discord.test.ts && npm run lint && npm run typecheck`
Expected: all PASS (existing join tests unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/discord.ts test/discord.test.ts
git commit -m "feat: discord embed for guild firsts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: ProgressRecorder wired into the guild sync

**Files:**
- Create: `src/progress.ts`
- Modify: `src/guild-sync.ts`, `src/app.ts`
- Test: `test/progress-recorder.test.ts`, `test/guild-sync.test.ts`

**Interfaces:**
- Consumes: `ProgressStore`, `utcDay` (Task 1); `detectMilestones`, `computeFirsts`, `claimedFirsts` (Task 2); `CharacterInfo.milestoneAchievements` (Task 3); `DiscordNotifier.guildFirsts` (Task 4); `Member`, `RosterMember` from `src/db.ts`.
- Produces:
  - `class ProgressRecorder(store: ProgressStore, notifier: Pick<DiscordNotifier, "guildFirsts"> | null, now?: () => number)` with `recordRoster(roster: RosterMember[]): void` and `recordArmory(m: Member, c: CharacterInfo): Promise<void>`
  - `GuildSync` constructor gains a 6th optional parameter `progress: ProgressRecorder | null = null`
  - `app.progress: ProgressStore` (Fastify decoration), used by Task 6

- [ ] **Step 1: Write the failing recorder tests**

Create `test/progress-recorder.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CharacterInfo } from "../src/armory.js";
import { openDatabase, type Member, type RosterMember } from "../src/db.js";
import { ProgressRecorder } from "../src/progress.js";
import { ProgressStore } from "../src/progress-store.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 5, 12);

const member = (name: string, level: number, mainClass = "warrior") => ({ characterName: name, surname: null, mainClass, level }) as unknown as Member;
const roster = (name: string, level: number, classId = "warrior"): RosterMember => ({ name, surname: null, slug: null, level, classId, rank: 4 });
const info = (over: Partial<CharacterInfo> = {}) =>
  ({ level: 1, classId: "warrior", race: "Orc", lastLogin: null, professions: null, pvp: null, milestoneAchievements: [], ...over }) as CharacterInfo;

function setup() {
  let t = T0;
  const store = new ProgressStore(openDatabase(":memory:"));
  const posts: [string, string[]][] = [];
  const notifier = { guildFirsts: async (who: { name: string }, claims: string[]) => void posts.push([who.name, claims]) };
  const rec = new ProgressRecorder(store, notifier, () => t);
  return { store, rec, posts, nextDay: () => (t += DAY), now: () => t };
}

test("roster pass snapshots every member's level and class, including low levels", () => {
  const { store, rec } = setup();
  rec.recordRoster([roster("Grom", 59), roster("Tiny", 3, "mage")]);
  assert.deepEqual(store.snapshots().map((s) => [s.name, s.day, s.classId, s.level, s.race]), [
    ["Grom", "2026-11-05", "warrior", 59, null],
    ["Tiny", "2026-11-05", "mage", 3, null],
  ]);
});

test("armory pass adds race, PvP and skills, keeping known values when a field is missing", async () => {
  const { store, rec } = setup();
  rec.recordRoster([roster("Grom", 40)]);
  await rec.recordArmory(member("Grom", 40), info({
    level: 40,
    pvp: { rank: 2, honorableKills: 31 },
    professions: { primary: ["mining"], secondary: [], skills: { mining: { skill: 150, max: 225 } }, recipes: [] } as unknown as CharacterInfo["professions"],
  }));
  await rec.recordArmory(member("Grom", 40), info({ level: 40, race: null }));
  assert.deepEqual(store.get("Grom", "2026-11-05"), {
    name: "Grom", day: "2026-11-05", classId: "warrior", race: "Orc", level: 40, pvpRank: 2, honorableKills: 31, skills: { mining: 150 },
  });
});

test("launch members are backfilled from achievements; nothing is announced", async () => {
  const { store, rec, posts } = setup();
  rec.recordRoster([roster("Grom", 60)]);
  await rec.recordArmory(member("Grom", 60), info({
    level: 60,
    milestoneAchievements: [{ kind: "level", key: "60", classId: "warrior", completedAt: "2026-10-01T00:00:00.000Z" }],
  }));
  assert.deepEqual(store.milestones().map((m) => [m.name, m.source, m.reachedAt]), [["Grom", "achievement", "2026-10-01T00:00:00.000Z"]]);
  assert.deepEqual(posts, []);
});

test("a ding observed on a later day is recorded with the login time and announced once", async () => {
  const { store, rec, posts, nextDay, now } = setup();
  rec.recordRoster([roster("Grom", 59)]);
  await rec.recordArmory(member("Grom", 59), info({ level: 59 }));
  nextDay();
  const login = new Date(now() - 3_600_000).toISOString();
  rec.recordRoster([roster("Grom", 60)]);
  await rec.recordArmory(member("Grom", 60), info({ level: 60, lastLogin: login }));
  await rec.recordArmory(member("Grom", 60), info({ level: 60, lastLogin: login }));
  const [m] = store.milestones();
  assert.deepEqual([m.source, m.reachedAt, m.announced], ["observed", login, true]);
  assert.deepEqual(posts, [["Grom", ["First to reach level 60", "First Warrior to reach level 60", "First Orc to reach level 60"]]]);
});

test("a ding that claims nothing is recorded but not announced", async () => {
  const { store, rec, posts, nextDay } = setup();
  store.addMilestone({ name: "Early", kind: "level", key: "60", classId: "warrior", race: "Orc", reachedAt: "2026-10-01T00:00:00.000Z", source: "achievement" });
  rec.recordRoster([roster("Grom", 59)]);
  nextDay();
  rec.recordRoster([roster("Grom", 60)]);
  await rec.recordArmory(member("Grom", 60), info({ level: 60 }));
  assert.equal(store.milestonesFor("Grom")[0].announced, false);
  assert.deepEqual(posts, []);
});

test("newcomers who arrive past a milestone are before_joining", async () => {
  const { store, rec, nextDay } = setup();
  rec.recordRoster([roster("Grom", 20)]);
  nextDay();
  rec.recordRoster([roster("Grom", 20), roster("Vet", 60)]);
  await rec.recordArmory(member("Vet", 60), info({ level: 60 }));
  assert.deepEqual(store.milestonesFor("Vet").map((m) => m.source), ["before_joining"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE_ENV=test node --import tsx --test test/progress-recorder.test.ts`
Expected: FAIL — `Cannot find module '../src/progress.js'`.

- [ ] **Step 3: Implement the recorder**

Create `src/progress.ts`:

```ts
import type { CharacterInfo } from "./armory.js";
import type { Member, RosterMember } from "./db.js";
import type { DiscordNotifier } from "./discord.js";
import { claimedFirsts, computeFirsts, detectMilestones } from "./milestones.js";
import { utcDay, type ProgressStore, type SnapshotPatch } from "./progress-store.js";

// Writes the guild sync's view of each character into daily snapshots, records milestones as
// they are crossed, and announces new guild firsts.
export class ProgressRecorder {
  constructor(
    private store: ProgressStore,
    private notifier: Pick<DiscordNotifier, "guildFirsts"> | null,
    private now: () => number = Date.now,
  ) {}

  // Every member's level and class, straight from the roster (so members below 10 are tracked).
  recordRoster(roster: RosterMember[]): void {
    this.store.upsertSnapshots(
      utcDay(this.now()),
      roster.map((r) => ({ name: r.name, patch: { classId: r.classId, level: r.level } })),
    );
  }

  // One character's armory read: race, PvP and skills, then any milestones it shows.
  async recordArmory(m: Member, c: CharacterInfo): Promise<void> {
    const nowMs = this.now();
    const day = utcDay(nowMs);
    const name = m.characterName;
    const skills = c.professions ? Object.fromEntries(Object.entries(c.professions.skills).map(([p, s]) => [p, s.skill])) : null;
    const patch: SnapshotPatch = {
      classId: m.mainClass,
      ...(c.race ? { race: c.race } : {}),
      ...(c.pvp ? { pvpRank: c.pvp.rank, honorableKills: c.pvp.honorableKills } : {}),
      ...(skills ? { skills } : {}),
    };
    // Read before writing today's row: detection compares against earlier days only.
    const prior = this.store.latestBefore(name, day);
    this.store.upsertSnapshot(name, day, patch);
    const today = this.store.get(name, day);
    if (!today) return;

    const added = detectMilestones({
      name,
      state: { classId: m.mainClass, race: today.race, level: Math.max(m.level, c.level), skills: today.skills, pvpRank: today.pvpRank },
      prior,
      launchMember: this.store.firstDay(name) === this.store.trackingSince(),
      existing: this.store.milestonesFor(name),
      achievements: c.milestoneAchievements,
      lastLogin: c.lastLogin,
      now: new Date(nowMs).toISOString(),
    }).filter((x) => this.store.addMilestone(x));

    const observed = added.filter((x) => x.source === "observed");
    if (observed.length === 0) return;
    const firsts = computeFirsts(this.store.milestones());
    const claiming = observed.map((x) => ({ x, claims: claimedFirsts(x, firsts) })).filter((e) => e.claims.length > 0);
    if (claiming.length === 0) return;
    for (const { x } of claiming) this.store.markAnnounced(x.name, x.kind, x.key);
    await this.notifier?.guildFirsts(
      { name, surname: m.surname, classId: m.mainClass },
      claiming.flatMap((e) => e.claims),
      observed[0].reachedAt ?? new Date(nowMs).toISOString(),
    );
  }
}
```

- [ ] **Step 4: Run recorder tests**

Run: `NODE_ENV=test node --import tsx --test test/progress-recorder.test.ts`
Expected: all 6 PASS.

- [ ] **Step 5: Write the failing guild-sync integration test**

In `test/guild-sync.test.ts`:

1. Add imports:

```ts
import { ProgressRecorder } from "../src/progress.js";
import { ProgressStore } from "../src/progress-store.js";
```

2. In `setup()`, replace the notifier and sync lines with:

```ts
  const firsts: [string, string[]][] = [];
  const notifier = {
    memberJoined: async (m: Member) => void joined.push(m),
    guildFirsts: async (who: { name: string }, claims: string[]) => void firsts.push([who.name, claims]),
  } as unknown as DiscordNotifier;
  const progress = new ProgressStore(db);
  const sync = new GuildSync(armory, store, notifier, quietLog, () => t, new ProgressRecorder(progress, notifier, () => t));
```

and add `progress, firsts,` to the returned object.

3. Append the test:

```ts
test("progress: every sync snapshots the roster, and a level-60 ding on a later day is an announced guild first", async () => {
  const { r, fake, sync, advance, roster, progress, firsts } = setup();
  await sync.sync();
  await sync.idle();
  assert.deepEqual(progress.snapshots().map((s) => [s.name, s.day, s.level]), [["Thrall", "1970-01-01", 20]]);
  assert.deepEqual(progress.milestones(), []);

  advance(24 * 60 * 60 * 1000);
  const login = 86_400_000 + 500_000;
  roster([rosterRow("Thrall", "thrall-durotan", 7, 60)]);
  r[char("thrall-durotan")] = { name: "Thrall", surname: "Durotan", level: 60, character_class: { id: 7 }, race: { name: "Orc" }, last_login_timestamp: login };
  fake.state.lastModified = "Tue, 15 Sep 2026 00:00:00 GMT"; // they played: the armory refetches
  await sync.sync();
  await sync.idle();

  assert.deepEqual(progress.snapshots().map((s) => [s.day, s.level, s.race]), [["1970-01-01", 20, null], ["1970-01-02", 60, "Orc"]]);
  assert.deepEqual(progress.milestones().map((m) => [m.name, m.kind, m.key, m.source, m.reachedAt]), [
    ["Thrall", "level", "60", "observed", new Date(login).toISOString()],
  ]);
  assert.deepEqual(firsts, [["Thrall", ["First to reach level 60", "First Shaman to reach level 60", "First Orc to reach level 60"]]]);
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `NODE_ENV=test node --import tsx --test test/guild-sync.test.ts`
Expected: FAIL — snapshots are empty (GuildSync ignores the 6th argument).

- [ ] **Step 7: Wire the recorder into GuildSync**

In `src/guild-sync.ts`:

1. Import: `import type { ProgressRecorder } from "./progress.js";`
2. Constructor — add a last parameter:

```ts
    private now: () => number = Date.now,
    private progress: ProgressRecorder | null = null,
  ) {}
```

3. In `run()`, right after `const added = this.store.syncRoster(roster);`:

```ts
    try {
      this.progress?.recordRoster(roster);
    } catch (err) {
      this.log.warn({ err }, "progress snapshot failed");
    }
```

4. In `enrich()`, right after the `this.store.applyArmory(m, {...});` call (inside the `try`):

```ts
      // History must never break the roster refresh.
      await this.progress?.recordArmory(m, c).catch((err: unknown) => {
        this.log.warn({ character: m.characterName, err }, "progress recording failed");
      });
```

- [ ] **Step 8: Wire into the app**

In `src/app.ts`:

1. Imports:

```ts
import { ProgressRecorder } from "./progress.js";
import { ProgressStore } from "./progress-store.js";
```

2. In the `FastifyInstance` declaration add `progress: ProgressStore;`.
3. Replace the guildSync construction:

```ts
  const progress = new ProgressStore(db);
  app.decorate("progress", progress);
  const guildSync = armory
    ? new GuildSync(armory, app.store, notifier, app.log, undefined, new ProgressRecorder(progress, notifier))
    : null;
```

- [ ] **Step 9: Run all tests, lint, typecheck**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all PASS.

- [ ] **Step 10: Commit**

```bash
git add src/progress.ts src/guild-sync.ts src/app.ts test/progress-recorder.test.ts test/guild-sync.test.ts
git commit -m "feat: record progress snapshots and guild firsts during the guild sync

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: GET /api/progress

**Files:**
- Create: `src/progress-report.ts`, `src/routes/progress.ts`
- Modify: `src/app.ts`
- Test: `test/progress-report.test.ts`, `test/progress-api.test.ts`

**Interfaces:**
- Consumes: `Snapshot`, `Milestone` (Task 1); `computeFirsts`, `Firsts` (Task 2); `app.progress` (Task 5).
- Produces (the JSON contract the browser uses in Tasks 7–8):

```ts
interface ProgressReport {
  trackingSince: string | null;
  series: { name: string; class: string; race: string | null; current: boolean; levels: [string, number][] }[];
  pvp: { name: string; class: string; race: string | null; current: boolean; rank: number; highestRank: number; honorableKills: number; history: [string, number, number][] }[];
  firsts: Firsts;
}
buildProgress(snapshots: Snapshot[], milestones: Milestone[], currentNames: string[]): ProgressReport
```

- [ ] **Step 1: Write the failing report test**

Create `test/progress-report.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProgress } from "../src/progress-report.js";
import type { Snapshot } from "../src/progress-store.js";

const s = (name: string, day: string, level: number, over: Partial<Snapshot> = {}): Snapshot => ({
  name, day, classId: "warrior", race: "Orc", level, pvpRank: null, honorableKills: null, skills: {}, ...over,
});

test("empty history", () => {
  const r = buildProgress([], [], []);
  assert.equal(r.trackingSince, null);
  assert.deepEqual(r.series, []);
  assert.deepEqual(r.pvp, []);
  assert.deepEqual(r.firsts.overall60, { holders: [], atLaunch: [] });
});

test("series keep first, last and both sides of each change, so plateaus stay flat", () => {
  const r = buildProgress(
    [s("Grom", "2026-11-01", 40), s("Grom", "2026-11-02", 40), s("Grom", "2026-11-03", 40), s("Grom", "2026-11-04", 42), s("Grom", "2026-11-05", 42), s("Grom", "2026-11-06", 42)],
    [],
    ["grom"],
  );
  assert.equal(r.trackingSince, "2026-11-01");
  assert.deepEqual(r.series, [{
    name: "Grom", class: "warrior", race: "Orc", current: true,
    levels: [["2026-11-01", 40], ["2026-11-03", 40], ["2026-11-04", 42], ["2026-11-06", 42]],
  }]);
});

test("former members stay, flagged; PvP lists only characters with rank or kills", () => {
  const r = buildProgress(
    [
      s("Arg", "2026-11-01", 30, { pvpRank: 0, honorableKills: 0 }),
      s("Grom", "2026-11-01", 50, { pvpRank: 3, honorableKills: 100 }),
      s("Grom", "2026-11-02", 50, { pvpRank: 5, honorableKills: 400 }),
      s("Grom", "2026-11-03", 50, { pvpRank: 4, honorableKills: 450 }),
    ],
    [],
    ["arg"],
  );
  assert.deepEqual(r.series.map((x) => [x.name, x.current]), [["Arg", true], ["Grom", false]]);
  assert.deepEqual(r.pvp, [{
    name: "Grom", class: "warrior", race: "Orc", current: false, rank: 4, highestRank: 5, honorableKills: 450,
    history: [["2026-11-01", 3, 100], ["2026-11-02", 5, 400], ["2026-11-03", 4, 450]],
  }]);
});

test("races seen in snapshots appear in firsts.byRace even when unclaimed", () => {
  assert.deepEqual(Object.keys(buildProgress([s("Zap", "2026-11-01", 5, { race: "Gnome" })], [], []).firsts.byRace), ["Gnome"]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `NODE_ENV=test node --import tsx --test test/progress-report.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the report**

Create `src/progress-report.ts`:

```ts
import { computeFirsts, type Firsts } from "./milestones.js";
import type { Milestone, Snapshot } from "./progress-store.js";

export interface LevelSeries {
  name: string;
  class: string;
  race: string | null;
  current: boolean;
  levels: [string, number][];
}

export interface PvpSeries {
  name: string;
  class: string;
  race: string | null;
  current: boolean;
  rank: number;
  highestRank: number;
  honorableKills: number;
  history: [string, number, number][];
}

export interface ProgressReport {
  trackingSince: string | null;
  series: LevelSeries[];
  pvp: PvpSeries[];
  firsts: Firsts;
}

// Keeps the first and last rows and both rows around every change, dropping the middle of
// plateaus. Drawn as straight segments, that is the same line as every day's point.
function compress<T extends [string, ...number[]]>(rows: Snapshot[], point: (r: Snapshot) => T): T[] {
  const points = rows.map(point);
  const value = (p: T | undefined) => (p ? p.slice(1).join(",") : null);
  return points.filter((p, i) => i === 0 || i === points.length - 1 || value(p) !== value(points[i - 1]) || value(p) !== value(points[i + 1]));
}

// `snapshots` must be ordered by name, then day (ProgressStore.snapshots()).
export function buildProgress(snapshots: Snapshot[], milestones: Milestone[], currentNames: string[]): ProgressReport {
  const current = new Set(currentNames.map((n) => n.toLowerCase()));
  const byName = new Map<string, Snapshot[]>();
  for (const s of snapshots) {
    const key = s.name.toLowerCase();
    const list = byName.get(key) ?? [];
    list.push(s);
    byName.set(key, list);
  }

  const series: LevelSeries[] = [];
  const pvp: PvpSeries[] = [];
  for (const rows of byName.values()) {
    const last = rows[rows.length - 1];
    const who = { name: last.name, class: last.classId, race: last.race, current: current.has(last.name.toLowerCase()) };
    series.push({ ...who, levels: compress(rows, (r): [string, number] => [r.day, r.level]) });
    const ranked = rows.filter((r) => r.pvpRank !== null);
    if (!ranked.some((r) => (r.pvpRank ?? 0) > 0 || (r.honorableKills ?? 0) > 0)) continue;
    const latest = ranked[ranked.length - 1];
    pvp.push({
      ...who,
      rank: latest.pvpRank ?? 0,
      highestRank: Math.max(...ranked.map((r) => r.pvpRank ?? 0)),
      honorableKills: latest.honorableKills ?? 0,
      history: compress(ranked, (r): [string, number, number] => [r.day, r.pvpRank ?? 0, r.honorableKills ?? 0]),
    });
  }

  const days = snapshots.map((s) => s.day).sort();
  const races = [...new Set(snapshots.map((s) => s.race).filter((r): r is string => !!r))];
  return { trackingSince: days[0] ?? null, series, pvp, firsts: computeFirsts(milestones, currentNames, races) };
}
```

- [ ] **Step 4: Run report tests**

Run: `NODE_ENV=test node --import tsx --test test/progress-report.test.ts`
Expected: all 4 PASS.

- [ ] **Step 5: Write the failing route test**

Create `test/progress-api.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { sessionCookieName } from "../src/routes/auth.js";

const PASS = "for-the-horde-forever";
const base = { port: 0, dbPath: ":memory:", guildPassphrase: PASS, sessionSecret: "x".repeat(40), cookieSecure: false };

async function login(a: FastifyInstance) {
  const res = await a.inject({ method: "POST", url: "/api/login", payload: { passphrase: PASS } });
  const name = sessionCookieName(false);
  return { [name]: res.cookies.find((c) => c.name === name)!.value };
}

test("progress requires a session", async () => {
  const app = buildApp(base);
  await app.ready();
  try {
    assert.equal((await app.inject({ method: "GET", url: "/api/progress" })).statusCode, 401);
  } finally {
    await app.close();
  }
});

test("progress reports stored history, flagging former members", async () => {
  const app = buildApp(base);
  await app.ready();
  try {
    const cookies = await login(app);
    const empty = (await app.inject({ method: "GET", url: "/api/progress", cookies })).json();
    assert.equal(empty.trackingSince, null);
    assert.deepEqual(empty.series, []);

    app.store.syncRoster([{ name: "Grom", surname: null, slug: null, classId: "warrior", level: 42, rank: 4 }]);
    app.progress.upsertSnapshot("Grom", "2026-11-05", { classId: "warrior", level: 42 });
    app.progress.upsertSnapshot("Gone", "2026-11-05", { classId: "mage", level: 12 });
    const res = await app.inject({ method: "GET", url: "/api/progress", cookies });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.trackingSince, "2026-11-05");
    assert.deepEqual(body.series.map((s: { name: string; current: boolean }) => [s.name, s.current]), [["Gone", false], ["Grom", true]]);
  } finally {
    await app.close();
  }
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `NODE_ENV=test node --import tsx --test test/progress-api.test.ts`
Expected: FAIL — 404 instead of 401/200.

- [ ] **Step 7: Implement the route and register it**

Create `src/routes/progress.ts`:

```ts
import type { FastifyPluginCallback } from "fastify";
import { buildProgress } from "../progress-report.js";

// Level race, guild firsts and PvP history. Reads SQLite only; the guild sync fills it.
export const progressRoutes: FastifyPluginCallback = (app, _opts, done) => {
  app.get("/progress", async () =>
    buildProgress(app.progress.snapshots(), app.progress.milestones(), app.store.list().map((m) => m.characterName)),
  );
  done();
};
```

In `src/app.ts`: `import { progressRoutes } from "./routes/progress.js";` and inside the secured block add `secured.register(progressRoutes);` after `craftingRoutes`.

- [ ] **Step 8: Run all tests, lint, typecheck**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add src/progress-report.ts src/routes/progress.ts src/app.ts test/progress-report.test.ts test/progress-api.test.ts
git commit -m "feat: GET /api/progress

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Progress tab view models (pure browser JS)

**Files:**
- Create: `public/progress.js` (pure exports only in this task; rendering is Task 8)
- Test: `test/progress-ui.test.ts`

**Interfaces:**
- Consumes: the `ProgressReport` JSON (Task 6); `game` from `/api/game-data` (`classes: {id, name, color}[]`, `professions: {id, name}[]`).
- Produces (all exported from `public/progress.js`):
  - `TOP = 10`
  - `levelRace(series, { classes: Set<string>, today: string }) → { start, end, lines: (series & { leader: boolean })[] }` — lines ranked: highest current level, then earliest day that level was reached, then name
  - `daysBetween(a: string, b: string): number`
  - `linePath(points: [string, number][], geo: { start, end, width, height, min, max }): string` — SVG path `d`, extended flat to `end`
  - `spreadLabels(ys: number[], gap?: number): number[]`
  - `rankTitle(rank: number, race: string | null): string`
  - `firstsGroups(firsts, game) → { heading: string, cards: { id: string, title: string, rank?: number, holders: Holder[], atLaunch: string[] }[] }[]`
  - `pvpRows(pvp, { key: "name" | "rank" | "highest" | "hk", dir: 1 | -1 })`

- [ ] **Step 1: Write the failing tests**

Create `test/progress-ui.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { CLASSES, PROFESSIONS } from "../src/game-data.js";
import { daysBetween, firstsGroups, levelRace, linePath, pvpRows, rankTitle, spreadLabels, TOP } from "../public/progress.js";

const line = (name: string, cls: string, levels: [string, number][], current = true) => ({ name, class: cls, race: "Orc", current, levels });

test("levelRace ranks by level, then who got there first, then name; the top 10 lead", () => {
  const series = [
    line("Late", "warrior", [["2026-11-01", 50], ["2026-11-04", 60]]),
    line("Early", "mage", [["2026-11-01", 50], ["2026-11-02", 60]]),
    line("Alpha", "mage", [["2026-11-01", 40]]),
    ...Array.from({ length: TOP }, (_, i) => line(`Low${i}`, "rogue", [["2026-11-01", 10]])),
  ];
  const r = levelRace(series, { classes: new Set(), today: "2026-11-06" });
  assert.equal(r.start, "2026-11-01");
  assert.equal(r.end, "2026-11-06");
  assert.deepEqual(r.lines.slice(0, 3).map((l) => l.name), ["Early", "Late", "Alpha"]);
  assert.equal(r.lines.filter((l) => l.leader).length, TOP);
  assert.equal(r.lines.at(-1)?.leader, false);
});

test("levelRace filters by class and re-ranks within the filter", () => {
  const series = [line("A", "mage", [["2026-11-01", 30]]), line("B", "rogue", [["2026-11-01", 40]])];
  const r = levelRace(series, { classes: new Set(["mage"]), today: "2026-11-01" });
  assert.deepEqual(r.lines.map((l) => [l.name, l.leader]), [["A", true]]);
  assert.deepEqual(levelRace([], { classes: new Set(), today: "2026-11-01" }), { start: "2026-11-01", end: "2026-11-01", lines: [] });
});

test("linePath scales days and levels and extends the last level to today", () => {
  assert.equal(daysBetween("2026-11-01", "2026-11-11"), 10);
  const geo = { start: "2026-11-01", end: "2026-11-11", width: 100, height: 59, min: 1, max: 60 };
  assert.equal(linePath([["2026-11-01", 1], ["2026-11-06", 60]], geo), "M0,59L50,0L100,0");
  // a single day still spans the width
  assert.equal(linePath([["2026-11-01", 1]], { ...geo, end: "2026-11-01" }), "M0,59");
});

test("spreadLabels pushes overlapping labels apart and keeps input order", () => {
  // sorted: 10, 11→22, 12→34, 50; returned in input order
  assert.deepEqual(spreadLabels([10, 12, 50, 11], 12), [10, 34, 50, 22]);
});

test("rankTitle uses the faction's title, or the number when the race is unknown", () => {
  assert.equal(rankTitle(14, "Orc"), "High Warlord");
  assert.equal(rankTitle(14, "Night Elf"), "Grand Marshal");
  assert.equal(rankTitle(6, "Undead"), "Stone Guard");
  assert.equal(rankTitle(6, null), "Rank 6");
  assert.equal(rankTitle(0, "Orc"), "None");
});

test("firstsGroups orders level 60, classes, races, professions and PvP ranks", () => {
  const empty = { holders: [], atLaunch: [] };
  const firsts = {
    overall60: empty,
    byClass: Object.fromEntries(CLASSES.map((c) => [c.id, empty])),
    byRace: { Orc: empty, Gnome: empty },
    bySkill: Object.fromEntries(PROFESSIONS.map((p) => [p.id, empty])),
    byPvpRank: Object.fromEntries(Array.from({ length: 14 }, (_, i) => [String(i + 1), empty])),
  };
  const groups = firstsGroups(firsts, { classes: CLASSES, professions: PROFESSIONS });
  assert.deepEqual(groups.map((g) => [g.heading, g.cards.length]), [
    ["Level 60", 1], ["Classes", CLASSES.length], ["Races", 2], ["Professions", PROFESSIONS.length], ["PvP ranks", 14],
  ]);
  assert.equal(groups[0].cards[0].title, "First to 60");
  assert.equal(groups[1].cards[0].title, "Warrior");
  assert.deepEqual(groups[2].cards.map((c) => c.title), ["Gnome", "Orc"]);
  assert.equal(groups[3].cards[0].title, "Alchemy 300");
  assert.deepEqual([groups[4].cards[6].title, groups[4].cards[6].rank], ["Rank 7", 7]);
});

test("pvpRows sorts by the chosen column, ties by name", () => {
  const rows = [
    { name: "b", rank: 5, highestRank: 7, honorableKills: 10 },
    { name: "a", rank: 5, highestRank: 6, honorableKills: 30 },
    { name: "c", rank: 9, highestRank: 9, honorableKills: 20 },
  ];
  assert.deepEqual(pvpRows(rows, { key: "rank", dir: -1 }).map((r) => r.name), ["c", "a", "b"]);
  assert.deepEqual(pvpRows(rows, { key: "hk", dir: 1 }).map((r) => r.name), ["b", "c", "a"]);
  assert.deepEqual(pvpRows(rows, { key: "name", dir: 1 }).map((r) => r.name), ["a", "b", "c"]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `NODE_ENV=test node --import tsx --test test/progress-ui.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure models**

Create `public/progress.js`:

```js
// Progress tab: models are pure (unit tested from Node); rendering takes app helpers.
export const TOP = 10;
const DAY_MS = 86_400_000;

export const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);
const lastLevel = (s) => s.levels[s.levels.length - 1][1];
// The day the character first showed their current level.
const reachedOn = (s) => s.levels.find((p) => p[1] === lastLevel(s))[0];

// Lines ranked for the level race; the top TOP are leaders. classes: Set of class ids (empty = all).
export function levelRace(series, { classes, today }) {
  const shown = series.filter((s) => classes.size === 0 || classes.has(s.class));
  const ranked = [...shown].sort(
    (a, b) => lastLevel(b) - lastLevel(a) || reachedOn(a).localeCompare(reachedOn(b)) || a.name.localeCompare(b.name),
  );
  const start = shown.flatMap((s) => s.levels.map((p) => p[0])).reduce((a, b) => (a < b ? a : b), today);
  return { start, end: today, lines: ranked.map((s, i) => ({ ...s, leader: i < TOP })) };
}

const round = (n) => Math.round(n * 10) / 10;

// SVG path for [day, value] points in a width × height box, held flat out to geo.end.
export function linePath(points, { start, end, width, height, min, max }) {
  const span = Math.max(1, daysBetween(start, end));
  const x = (d) => round((daysBetween(start, d) / span) * width);
  const y = (v) => round(height - ((v - min) / (max - min)) * height);
  const pts = points.map(([d, v]) => [x(d), y(v)]);
  const last = points[points.length - 1];
  if (last && last[0] < end) pts.push([x(end), y(last[1])]);
  return "M" + pts.map(([a, b]) => `${a},${b}`).join("L");
}

// Nudges label y positions down so none are closer than `gap`; returns them in input order.
export function spreadLabels(ys, gap = 12) {
  const out = [];
  let prev = -Infinity;
  for (const [y, i] of ys.map((y, i) => [y, i]).sort((a, b) => a[0] - b[0])) {
    out[i] = Math.max(y, prev + gap);
    prev = out[i];
  }
  return out;
}

const HORDE = new Set(["Orc", "Troll", "Tauren", "Undead"]);
const ALLIANCE = new Set(["Human", "Dwarf", "Night Elf", "Gnome"]);
const TITLES = {
  horde: ["Scout", "Grunt", "Sergeant", "Senior Sergeant", "First Sergeant", "Stone Guard", "Blood Guard", "Legionnaire", "Centurion", "Champion", "Lieutenant General", "General", "Warlord", "High Warlord"],
  alliance: ["Private", "Corporal", "Sergeant", "Master Sergeant", "Sergeant Major", "Knight", "Knight-Lieutenant", "Knight-Captain", "Knight-Champion", "Lieutenant Commander", "Commander", "Marshal", "Field Marshal", "Grand Marshal"],
};

export function rankTitle(rank, race) {
  if (!rank) return "None";
  const titles = HORDE.has(race) ? TITLES.horde : ALLIANCE.has(race) ? TITLES.alliance : null;
  return titles?.[rank - 1] ?? `Rank ${rank}`;
}

// Cards for the guild firsts board, grouped and ordered for display.
export function firstsGroups(firsts, game) {
  const card = (id, title, c, extra = {}) => ({ id, title, holders: c.holders, atLaunch: c.atLaunch, ...extra });
  return [
    { heading: "Level 60", cards: [card("overall", "First to 60", firsts.overall60)] },
    { heading: "Classes", cards: game.classes.map((c) => card(`class-${c.id}`, c.name, firsts.byClass[c.id], { classId: c.id })) },
    { heading: "Races", cards: Object.keys(firsts.byRace).sort().map((r) => card(`race-${r}`, r, firsts.byRace[r])) },
    { heading: "Professions", cards: game.professions.map((p) => card(`skill-${p.id}`, `${p.name} 300`, firsts.bySkill[p.id])) },
    {
      heading: "PvP ranks",
      cards: Object.keys(firsts.byPvpRank)
        .map(Number)
        .sort((a, b) => a - b)
        .map((n) => card(`rank-${n}`, `Rank ${n}`, firsts.byPvpRank[String(n)], { rank: n })),
    },
  ];
}

const PVP_SORT = {
  name: (r) => r.name.toLowerCase(),
  rank: (r) => r.rank,
  highest: (r) => r.highestRank,
  hk: (r) => r.honorableKills,
};

export function pvpRows(pvp, { key, dir }) {
  const value = PVP_SORT[key];
  return [...pvp].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    return x === y ? a.name.localeCompare(b.name) : (x < y ? -1 : 1) * dir;
  });
}
```

- [ ] **Step 4: Run tests, lint**

Run: `NODE_ENV=test node --import tsx --test test/progress-ui.test.ts && npm run lint`
Expected: all 7 PASS; lint clean.

- [ ] **Step 5: Commit**

```bash
git add public/progress.js test/progress-ui.test.ts
git commit -m "feat: progress tab view models

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Progress tab UI

**Files:**
- Modify: `public/progress.js` (append `renderProgress`), `public/index.html`, `public/app.js`, `public/style.css`

**Interfaces:**
- Consumes: Task 7 exports; `/api/progress` (Task 6); app.js helpers `esc`, `characterName(m, cls)`, `paintClasses(root)`, `game`.
- Produces: `renderProgress(root, data, state, { esc, characterName, paintClasses, game, today })` where `state = { classes: Set<string>, pvpSort: { key, dir } }`.

- [ ] **Step 1: Append the renderer to `public/progress.js`**

```js
// ---------- Rendering ----------
const W = 800;
const H = 340;
const PAD = { l: 34, r: 130, t: 12, b: 26 };
const IW = W - PAD.l - PAD.r;
const IH = H - PAD.t - PAD.b;
const fmtDate = (iso) => new Date(iso).toLocaleDateString();

function raceChart(model, { esc, colorOf }) {
  const geo = { start: model.start, end: model.end, width: IW, height: IH, min: 1, max: 60 };
  const y = (v) => round(IH - ((v - 1) / 59) * IH);
  const grid = [10, 20, 30, 40, 50, 60]
    .map((v) => `<line class="race-grid" x1="0" x2="${IW}" y1="${y(v)}" y2="${y(v)}"/><text class="race-axis" x="-6" y="${y(v)}" text-anchor="end" dominant-baseline="middle">${v}</text>`)
    .join("");
  const axis = `<text class="race-axis" x="0" y="${IH + 18}">${esc(model.start)}</text><text class="race-axis" x="${IW}" y="${IH + 18}" text-anchor="end">${esc(model.end)}</text>`;
  const path = (l) => {
    const level = lastLevel(l);
    const cls = `race-line${l.leader ? " leader" : ""}${l.current ? "" : " former"}`;
    const stroke = l.leader ? ` stroke="${esc(colorOf(l.class))}"` : "";
    const focus = l.leader ? ' tabindex="0"' : "";
    return `<path class="${cls}" d="${linePath(l.levels, geo)}"${stroke}${focus}><title>${esc(l.name)} — level ${level}${l.current ? "" : " (former member)"}</title></path>`;
  };
  // Leaders on top, first place last so it is drawn over the others.
  const pack = model.lines.filter((l) => !l.leader).map(path).join("");
  const leaders = model.lines.filter((l) => l.leader);
  const lines = [...leaders].reverse().map(path).join("");
  const labelYs = spreadLabels(leaders.map((l) => y(lastLevel(l))));
  const labels = leaders
    .map((l, i) => `<text class="race-label" x="${IW + 6}" y="${labelYs[i]}" dominant-baseline="middle" fill="${esc(colorOf(l.class))}">${esc(l.name)} ${lastLevel(l)}</text>`)
    .join("");
  return `<svg class="race-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Level over time"><g transform="translate(${PAD.l},${PAD.t})">${grid}${axis}${pack}${lines}${labels}</g></svg>`;
}

function spark(history, { esc, today }) {
  const points = history.map(([d, rank]) => [d, rank]);
  const geo = { start: points[0][0], end: today, width: 80, height: 18, min: 0, max: 14 };
  return `<svg class="spark" viewBox="-1 -1 82 20" role="img" aria-label="${esc(`Rank history, now ${points[points.length - 1][1]}`)}"><path d="${linePath(points, geo)}"/></svg>`;
}

// Renders the Progress tab into `root` (#progress-panel).
export function renderProgress(root, data, state, { esc, characterName, paintClasses, game, today }) {
  const colorOf = (id) => game.classes.find((c) => c.id === id)?.color ?? "#C0C0C0";
  const who = (name, current) =>
    current ? characterName({ characterName: name, surname: null }, "member") : `<span class="member former">${esc(name)}</span> <span class="muted">(former)</span>`;

  // Class filter
  const counts = {};
  for (const s of data.series) counts[s.class] = (counts[s.class] ?? 0) + 1;
  root.querySelector("#progress-class-filter").innerHTML =
    `<button type="button" class="chip" data-progress-class="" aria-pressed="${state.classes.size === 0}">All <b>${data.series.length}</b></button>` +
    game.classes
      .filter((c) => counts[c.id])
      .map((c) => `<button type="button" class="chip" data-progress-class="${esc(c.id)}" aria-pressed="${state.classes.has(c.id)}"><span class="cls" data-class="${esc(c.id)}">${esc(c.name)}</span> <b>${counts[c.id]}</b></button>`)
      .join("");

  // Level race
  const model = levelRace(data.series, { classes: state.classes, today });
  const chart = root.querySelector("#race-chart");
  const note = root.querySelector("#race-note");
  if (!data.trackingSince) {
    chart.innerHTML = "";
    note.textContent = "No history yet. It fills in as the guild sync runs.";
  } else if (data.trackingSince === today) {
    chart.innerHTML = "";
    note.textContent = `Tracking started ${data.trackingSince}; the race fills in as people level.`;
  } else {
    chart.innerHTML = model.lines.length ? raceChart(model, { esc, colorOf }) : '<p class="muted">No members play the selected classes.</p>';
    note.textContent = `Since ${data.trackingSince}. Top ${TOP} highlighted; hover any line for its name.`;
  }

  // Guild firsts
  const holderLi = (h, rank) =>
    `<li>${who(h.name, h.current)}${rank ? ` <span class="muted">${esc(rankTitle(rank, data.series.find((s) => s.name === h.name)?.race ?? null))}</span>` : ""} <span class="muted">· ${esc(fmtDate(h.reachedAt))}${h.source === "achievement" ? " · via achievement" : ""}</span></li>`;
  const cardHtml = (c) => `<article class="first-card">
      <h4>${c.classId ? `<span class="cls" data-class="${esc(c.classId)}">${esc(c.title)}</span>` : esc(c.title)}</h4>
      ${c.holders.length ? `<ol class="first-holders">${c.holders.map((h) => holderLi(h, c.rank)).join("")}</ol>` : c.atLaunch.length ? "" : '<p class="muted">Unclaimed</p>'}
      ${c.atLaunch.length ? `<p class="muted small">Already there at launch: ${c.atLaunch.map((n) => esc(n)).join(", ")}</p>` : ""}
    </article>`;
  root.querySelector("#firsts").innerHTML = firstsGroups(data.firsts, game)
    .filter((g) => g.cards.length)
    .map((g) => `<section class="firsts-group"><h3>${esc(g.heading)}</h3><div class="firsts-grid">${g.cards.map(cardHtml).join("")}</div></section>`)
    .join("");

  // PvP tracker
  root.querySelector("#pvp-section").classList.toggle("hidden", data.pvp.length === 0);
  for (const b of root.querySelectorAll("button[data-pvp-sort]")) {
    const on = b.dataset.pvpSort === state.pvpSort.key;
    b.closest("th").setAttribute("aria-sort", on ? (state.pvpSort.dir === 1 ? "ascending" : "descending") : "none");
  }
  root.querySelector("#pvp-body").innerHTML = pvpRows(data.pvp, state.pvpSort)
    .map(
      (r) => `<tr>
        <td><span class="cls" data-class="${esc(r.class)}">${who(r.name, r.current)}</span></td>
        <td>${r.rank} <span class="muted">${esc(rankTitle(r.rank, r.race))}</span></td>
        <td>${r.highestRank} <span class="muted">${esc(rankTitle(r.highestRank, r.race))}</span></td>
        <td>${r.honorableKills.toLocaleString()}</td>
        <td>${spark(r.history, { esc, today })}</td>
      </tr>`,
    )
    .join("");
  paintClasses(root);
}
```

- [ ] **Step 2: Add the tab and panel to `public/index.html`**

After the Crafting tab link:

```html
        <a href="#progress" id="progress-tab" class="tab hidden" data-tab="progress">Progress</a>
```

After the `#crafting-panel` section (still inside `#roster`):

```html
      <section id="progress-panel" class="panel hidden" aria-label="Progress">
        <h2>Level Race</h2>
        <p id="progress-status" class="muted" role="status"></p>
        <div id="progress-class-filter" class="filters" role="group" aria-label="Filter by class"></div>
        <figure class="race-chart">
          <div id="race-chart"></div>
          <figcaption id="race-note" class="muted"></figcaption>
        </figure>
        <h2>Guild Firsts</h2>
        <div id="firsts"></div>
        <div id="pvp-section" class="hidden">
          <h2>PvP Ranks</h2>
          <table class="roster pvp-table">
            <thead>
              <tr>
                <th><button type="button" class="sort" data-pvp-sort="name">Character</button></th>
                <th><button type="button" class="sort" data-pvp-sort="rank">Rank</button></th>
                <th><button type="button" class="sort" data-pvp-sort="highest">Highest</button></th>
                <th><button type="button" class="sort" data-pvp-sort="hk">Honorable Kills</button></th>
                <th>History</th>
              </tr>
            </thead>
            <tbody id="pvp-body"></tbody>
          </table>
        </div>
      </section>
```

- [ ] **Step 3: Wire `public/app.js`**

1. Import: `import { renderProgress } from "./progress.js";`
2. State, next to the crafting state:

```js
let progress = null; // /api/progress body
const progressState = { classes: new Set(), pvpSort: { key: "rank", dir: -1 } };
```

3. Replace `TABS` and the first two lines of `applyTab()`:

```js
const TABS = ["roster", "classes", "crafting", "progress"];

function applyTab() {
  const wanted = location.hash.slice(1);
  const hiddenTab = document.querySelector(`.tab[data-tab="${wanted}"]`)?.classList.contains("hidden");
  const tab = TABS.includes(wanted) && !hiddenTab ? wanted : "roster";
```

and add next to the other panel toggles and loaders in `applyTab()`:

```js
  $("#progress-panel").classList.toggle("hidden", tab !== "progress");
```
```js
  if (tab === "progress") loadProgress();
```

4. Add after `loadCrafting()`:

```js
// ---------- Progress ----------
function drawProgress() {
  if (!progress) return;
  renderProgress($("#progress-panel"), progress, progressState, {
    esc, characterName, paintClasses, game, today: new Date().toISOString().slice(0, 10),
  });
}

async function loadProgress() {
  if (progress) return drawProgress();
  const r = await api("GET", "/api/progress");
  if (r.status === 401) return showGate("Your session expired. Enter the passphrase again.");
  $("#progress-status").textContent = r.ok ? "" : "Progress could not be read. Try again shortly.";
  if (!r.ok) return;
  progress = r.data;
  drawProgress();
}
```

5. In `loadMembers()`, next to `crafting = null;`:

```js
  progress = null;
  if (armory && location.hash === "#progress") loadProgress();
```

6. In `initArmory()`, before `applyTab();`:

```js
  // Progress history is filled by the guild sync, which needs the armory.
  $("#progress-tab").classList.remove("hidden");
```

7. Event listeners, next to the crafting ones:

```js
$("#progress-class-filter").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-progress-class]");
  if (!btn) return;
  const id = btn.dataset.progressClass;
  if (!id) progressState.classes.clear();
  else if (progressState.classes.has(id)) progressState.classes.delete(id);
  else progressState.classes.add(id);
  drawProgress();
});
$("#pvp-section thead").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-pvp-sort]");
  if (!btn) return;
  const key = btn.dataset.pvpSort;
  progressState.pvpSort = key === progressState.pvpSort.key
    ? { key, dir: -progressState.pvpSort.dir }
    : { key, dir: key === "name" ? 1 : -1 };
  drawProgress();
});
```

- [ ] **Step 4: Styles — append to `public/style.css`**

```css
/* Progress: level race */
.race-chart { margin: 0 0 16px; }
.race-svg { width: 100%; height: auto; display: block; }
.race-grid { stroke: rgba(107, 90, 51, 0.35); stroke-width: 1; }
.race-axis { fill: var(--muted); font-size: 11px; }
.race-line { fill: none; stroke: var(--gold-dim); stroke-width: 1; opacity: 0.45; }
.race-line.former { opacity: 0.2; stroke-dasharray: 3 3; }
.race-line.leader { stroke-width: 2.5; opacity: 1; }
.race-line:hover, .race-line:focus { stroke: var(--gold-hi); stroke-width: 3.5; opacity: 1; outline: none; }
.race-label { font-size: 12px; font-family: var(--font-head); }

/* Progress: guild firsts */
.firsts-group { margin: 12px 0 0; }
.firsts-group h3 { margin: 0 0 6px; font-size: 14px; color: var(--gold); text-transform: uppercase; letter-spacing: 0.04em; }
.firsts-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px; }
.first-card { border: 1px solid var(--gold-dim); border-radius: 4px; padding: 8px 10px; background: #0f0d09; }
.first-card h4 { margin: 0 0 4px; font-family: var(--font-head); font-size: 14px; }
.first-holders { margin: 0; padding-left: 18px; font-size: 14px; }
.first-holders li:first-child { color: var(--gold-hi); }
.first-card p { margin: 0; }
.small { font-size: 12px; }
.member.former { font-style: italic; }

/* Progress: PvP */
.pvp-table td { vertical-align: middle; }
.spark { width: 80px; height: 20px; }
.spark path { fill: none; stroke: var(--gold); stroke-width: 1.5; }
```

- [ ] **Step 5: Run the automated checks**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all PASS.

- [ ] **Step 6: Check it in the browser**

Use the `run` skill (or `npm run dev` with `.env` sourced) and open `http://localhost:3000/#progress` after logging in. Verify:
- The Progress tab appears once the armory status loads; with a fresh database the chart note reads "Tracking started <today>…".
- To see a chart without waiting days, stop the server, insert a few backdated rows with `sqlite3 data/roster.db "INSERT INTO member_snapshots (character_name, day, class, level) VALUES ('Testa','2026-11-01','mage',20),('Testa','2026-11-03','mage',35);"` then restart and reload: a line appears (as a former member, dashed), and the class filter, hover tooltip and keyboard focus on leaders work. Delete the rows afterwards: `sqlite3 data/roster.db "DELETE FROM member_snapshots WHERE character_name='Testa';"`.
- Firsts cards render all groups; PvP table shows when anyone has honour; sorting toggles.
- No CSP errors in the browser console.

- [ ] **Step 7: Commit**

```bash
git add public/progress.js public/index.html public/app.js public/style.css
git commit -m "feat: Progress tab with level race, guild firsts and PvP ranks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Docs

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the API row** after the `/api/crafting` row:

```markdown
| GET    | /api/progress      | level history, guild firsts and PvP ranks (from stored snapshots; no Blizzard calls) |
```

- [ ] **Step 2: Add a section** after "Crafting directory":

```markdown
## Progress: level race, guild firsts, PvP ranks

The Progress tab charts every character's level over time (the top 10 in
class colour), lists guild firsts (first to 60 overall, per class and per
race; first to 300 in each profession; first to each PvP rank), and tracks
current and highest PvP rank with honorable kills.

- The guild sync writes one snapshot per character per UTC day (level from
  the roster; race, PvP and skills from the armory, level 10+). Days when the
  server is asleep have no snapshot; the chart joins the points around them.
- A milestone crossed after tracking began is dated by the character's last
  login. On Forever, members already past a milestone when tracking began are
  dated from their Legacy achievements ("Master <Class>", "Artisan
  <Profession>", "Rank N") when the character qualifies; otherwise they are
  listed as "already there at launch". Those achievements are account-wide,
  so such dates are marked "via achievement".
- Characters who join already past a milestone don't take guild firsts.
- History and firsts are kept when a member leaves (shown as former members).
- With `DISCORD_WEBHOOK_URL` set, new guild firsts are announced. Firsts
  found at launch or from achievements are not.
- `reset-data` also clears progress history.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: progress tab, guild firsts and PvP tracker

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
