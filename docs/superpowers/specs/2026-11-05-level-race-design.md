# Level Race, Guild Firsts and PvP Tracker — Design

Date: 2026-11-05

## Purpose

Show the guild's progress over time: who is leveling fastest, who got to 60
(and to 300 skill, and to each PvP rank) first, and where everyone stands in
the honor system.

## Decisions (from brainstorming)

- Scope: one spec covering daily snapshots, the level race chart, the guild
  firsts board and the PvP rank tracker.
- Architecture: daily snapshot rows feed the charts; a separate milestones
  table is written during sync whenever a threshold is crossed. Firsts are
  derived from milestones on read.
- Milestones already reached before tracking: backfilled from Forever's
  Legacy achievements where one exists and passes a sanity check; otherwise
  "before tracking", unranked.
- Chart: every character drawn as a faint line; the top 10 highlighted.
- Discord: newly claimed firsts that we observed live are announced.
- Leavers: snapshots and milestones are kept. Former members stay on the
  chart (faded) and keep their firsts.

## Data available (verified against static-forever-us, 2026-11-05)

- Roster: every member's level (including below 10).
- Armory (level 10+): race, profession skills, `pvp-summary` with
  `pvp_rank` (0–14) and `honorable_kills`, `last_login_timestamp`, and the
  character's achievements with `completed_timestamp`.
- Milestone achievements, all `is_account_wide: true`, all Legacy (each id
  exists twice, once per faction):
  - "Master <Class>": "Reach level 60 for the first time on a <Class>".
  - "Journeyman / Expert / Artisan <Profession>": 150 / 225 / 300 skill.
    Only Alchemy, Blacksmithing, Enchanting, Engineering, Leatherworking and
    Tailoring.
  - "Rank 3 / 7 / 10 / 13 / 14": PvP ranks.
  - Nothing for Cooking, First Aid, Fishing, Herbalism, Mining, Skinning,
    other PvP ranks, or races.
- Because they are account-wide, an achievement's timestamp may belong to a
  different character on the same account.

## Data model

### `member_snapshots`

One row per character per UTC day. Primary key
`(character_name COLLATE NOCASE, day)`; `day` is `YYYY-MM-DD`.

| Column            | Type    | Notes                                      |
|-------------------|---------|--------------------------------------------|
| character_name    | TEXT    | Not a foreign key: survives leaving        |
| day               | TEXT    | UTC date                                   |
| class             | TEXT    | game-data class id                         |
| race              | TEXT    | null below level 10                        |
| level             | INTEGER | from the roster                            |
| pvp_rank          | INTEGER | null below 10 / no PvP data                |
| honorable_kills   | INTEGER | null below 10 / no PvP data                |
| skills            | TEXT    | JSON `{ professionId: skill }`, `{}` if unknown |

Each write upserts the day's row with the latest values. A column the current
write doesn't know (e.g. armory fields during the roster pass) keeps its value
from today's row, or else from the character's most recent earlier row.

Keyed by name, so a character who rejoins continues their history.

### `milestones`

One row per character per milestone. Unique `(character_name COLLATE NOCASE,
kind, key)`.

| Column         | Type    | Notes                                                    |
|----------------|---------|----------------------------------------------------------|
| character_name | TEXT    |                                                          |
| kind           | TEXT    | `level`, `skill`, `pvp_rank`                             |
| key            | TEXT    | `60`; a profession id; `1`–`14`                          |
| class          | TEXT    | at the time reached                                      |
| race           | TEXT    | at the time reached (may be null if never seen ≥10)      |
| reached_at     | TEXT    | ISO timestamp; null when unknown                         |
| source         | TEXT    | `observed`, `achievement`, `before_tracking`, `before_joining` |
| announced      | INTEGER | 0/1                                                      |

Thresholds: level 60; skill 300 in any of the twelve professions in
`PROFESSIONS`; each PvP rank 1–14 (reaching rank 6 directly records 1–6).
Class and race firsts are the `level/60` rows grouped by `class` / `race`.

`reset-data` also clears both tables.

## Capture

All capture happens inside the existing guild sync. No new timers or Blizzard
calls, except that the character's achievements, already fetched on Forever
for Legacy progress, are now also returned for backfill.

1. **Roster pass** (`syncRoster`): upsert today's snapshot for every member
   with `level` and `class`, and run crossing detection for `level/60`.
   Characters below 10 are tracked here only.
2. **Armory refresh** (`enrich`): upsert today's snapshot with `race`,
   `pvp_rank`, `honorable_kills` and `skills`, then run crossing detection
   for skills and PvP ranks.

`CharacterInfo.pvp` is already read; it is added to `MemberArmory` alongside
the raw achievement list `{ id, completedAt }[]` needed for backfill (not
stored in the member row; passed to the milestone recorder).

### Crossing detection

For each threshold the character meets now and has no milestone row for:

- **Previously seen**: for `level`, the character has a stored level below
  the threshold; for `skill` / `pvp_rank`, the character has an earlier
  snapshot with armory data (`race` not null). Record `observed`,
  `reached_at` = `lastLogin` if present and later than that earlier
  snapshot's day start, else now.
- **First sighting, launch member** (the character's first snapshot day is
  `trackingSince`, i.e. they were on the roster when tracking began): look
  up the matching achievement. If the character has completed it, currently
  satisfies the milestone (a "Master Druid" timestamp only counts for a
  level-60 Druid), and the timestamp is not in the future, record
  `achievement` with that timestamp; otherwise `before_tracking` with
  `reached_at` null. The roster pass leaves first-sighting `level/60` to the
  armory refresh, which has the achievements, so a refresh that fails on
  launch day simply resolves on a later one.
- **First sighting, newcomer** (first snapshot day after `trackingSince`):
  record `before_joining`, `reached_at` null.

Achievement ids are matched by name from the static achievement catalog
already read weekly for Legacy progress (`Master <Class>`, `Artisan
<Profession>`, `Rank N`), so both faction copies are covered without
hard-coding ids. Only the 300-skill (Artisan) achievement is used.

PvP rank can decay; milestones are never removed. The tracker reports
current and highest rank separately.

### Discord

After recording an `observed` milestone, recompute the firsts it can affect
(overall 60, its class, its race, its profession, its rank). If it is now
the earliest in any of them, post one embed naming every first it claimed
(e.g. "Grom is the first Warrior and first Orc to reach 60!") in the class
colour, linking to `SITE_URL/#progress`. Set `announced = 1` whether or not
delivery succeeds (best-effort, as for joins). Non-observed rows are never
posted.

## API

`GET /api/progress` (session required, SQLite only, no Blizzard calls):

```jsonc
{
  "trackingSince": "2026-11-06",          // first snapshot day, or null
  "series": [                              // one per character ever seen
    { "name": "Grom", "class": "warrior", "race": "Orc", "current": true,
      "levels": [["2026-11-06", 41], ["2026-11-09", 44], ...] }
  ],
  "pvp": [                                 // characters with any rank or HK
    { "name": "Grom", "class": "warrior", "current": true,
      "rank": 6, "highestRank": 7, "honorableKills": 1234,
      "history": [["2026-11-06", 5, 900], ...] }
  ],
  "firsts": {
    "overall60": Category,
    "byClass": { "warrior": Category, ... },
    "byRace": { "Orc": Category, ... },
    "bySkill": { "alchemy": Category, ... },
    "byPvpRank": { "1": Category, ..., "14": Category }
  }
}
// Category = { holders: Holder[] /* up to 3, earliest first */, atLaunch: string[] }
// Holder   = { name, class, current, reachedAt, source }
```

- Series points are emitted only on days the value changed, plus the latest
  day.
- `holders` contains rows with a `reached_at` (`observed`, `achievement`),
  ordered by `reached_at`, ties by name. `atLaunch` lists `before_tracking`
  names. `before_joining` rows appear in neither.
- `byClass` / `bySkill` / `byPvpRank` include every key, empty when
  unclaimed. `byRace` includes races seen in any snapshot.

## UI: Progress tab

A fourth tab, "Progress" (`#progress`), in `public/progress.js`. Pure model
functions (series → chart model, firsts → cards, PvP → rows) are exported
separately from DOM code and unit tested from Node, like
`class-overview.js`.

### Level race

- Hand-drawn SVG (CSP is `script-src 'self'`; no library). X: days from
  `trackingSince` to today; Y: level 1–60.
- Every character as a thin, low-contrast line (former members fainter).
- Top 10 (highest current level; ties by who reached it first, then name)
  drawn thicker in class colour with an end-of-line name label.
- Hover / keyboard focus on any line highlights it and shows name, level and
  date. The Classes tab's class filter is reused to narrow the set; the top
  10 is recomputed within the filter.
- Only one snapshot so far: a short note ("Tracking started <date>; the race
  fills in as people level") instead of an empty chart.

### Guild firsts

Card grid, in order: First to 60; classes; races; professions at 300; PvP
ranks 1–14 (with rank titles for the member's faction). Each card shows the
holder, date and a "via achievement" marker when backfilled, the next two
runners-up, "Already there at launch: …" when `atLaunch` is non-empty, or
"Unclaimed". Former members are marked.

### PvP tracker

Sortable table of characters with any rank or HK: name, current rank (number
+ title), highest rank, honorable kills, and an inline SVG sparkline of rank
over time. Hidden when nobody has PvP data.

## Errors and edge cases

- Armory refresh fails: that member's armory fields and milestones are
  skipped this run; the next refresh compares against the last stored
  snapshot, so crossings are still caught (dated by `lastLogin`).
- Fly machine asleep: no snapshot that day; chart lines interpolate between
  points. Milestone dates are unaffected because they use `lastLogin`.
- Name changes look like a leave plus a new character (no stable id across
  renames in the roster API).
- Class ids not in game data are already filtered out by the guild sync.

## Testing

- Snapshot upsert: same-day overwrite, carry-forward of unknown columns.
- Crossing detection: observed with and without `lastLogin`; seeding with a
  valid achievement, with a mismatched class (rejected), with no achievement;
  newcomer → `before_joining`; PvP rank jump records every rank; rank decay
  keeps milestones.
- Firsts: ordering, tie-break, `atLaunch`, `before_joining` exclusion,
  former members retained.
- Discord: posts only for observed rows that become a first; one embed per
  milestone listing all categories claimed; never during seeding.
- `/api/progress`: 401 without session; empty database; change-day
  compression.
- Pure UI models: top-10 selection and ties, filter recompute, card
  building, PvP rows.
- `reset-data` clears both tables.

## Out of scope

- Milestones other than 60, 300 skill and PvP ranks (e.g. level 10s, 150 /
  225 skill, reputation).
- Per-member opt-out of the PvP tracker.
- Backfilling level history (only milestone dates are backfilled).
