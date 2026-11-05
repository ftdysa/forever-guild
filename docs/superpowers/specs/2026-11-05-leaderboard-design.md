# Leveling Milestones and Leaderboard — Design

Date: 2026-11-05. Builds on `2026-11-05-level-race-design.md` (shipped in PR #13).

## Decisions (from brainstorming)

- Level milestones every 10 levels: 10, 20, 30, 40, 50, 60.
- Firsts per level: overall and per class. Race firsts stay level 60 only.
- Discord: new levels announce the overall first only ("First to reach level 30").
  Level 60 keeps announcing overall, class and race.
- Leaderboard at the top of the Progress tab, current members only, four panels:
  level standings, fastest this week, most guild firsts, profession skill.
- Computed server-side in `/api/progress`.

## Milestones

- `kind: "level"`, `key` = `"10"` … `"60"`. A character at level 37 meets 10, 20 and 30.
- Detection per level threshold works like 60 today: the comparison snapshot is the latest
  earlier-day snapshot with level below that threshold; if one exists the crossing is
  `observed` (dated by last login), otherwise the first-sighting rules apply (launch member →
  achievement if any, else `before_tracking`; newcomer → `before_joining`).
- Only level 60 has a Legacy achievement ("Master <Class>"), so only 60 can be backfilled.

## Firsts shape (replaces `overall60` / `byClass`)

```ts
interface Firsts {
  byLevel: Record<"10"|"20"|"30"|"40"|"50"|"60", Category>;          // overall
  byClassLevel: Record<classId, Record<levelKey, Category>>;         // every class × every level
  byRace: Record<race, Category>;                                    // level 60 only
  bySkill: Record<professionId, Category>;
  byPvpRank: Record<"1".."14", Category>;
}
```

Claim labels: `First to reach level N` (every level); `First <Class> to reach level 60` and
`First <Race> to reach level 60` (60 only — class firsts at lower levels show on the site but are
not announced).

## Leaderboard (`ProgressReport.leaderboard`)

All lists contain current members only.

- `standings`: every current member with a snapshot, ranked by current level desc, then the day
  they first showed that level asc, then name. Each row: `name, class, race, level, reachedOn,
  gained7d`.
- `fastest`: top 10 rows from `standings` by `gained7d` desc (ties: higher level, then name),
  only rows with `gained7d > 0`.
- `gained7d` = current level − level on the baseline snapshot, where the baseline is the
  character's latest snapshot dated on or before `today − 7 days`, or else their earliest
  snapshot. `today` is the server's current UTC day.
- `mostFirsts`: top 10 `{ name, class, count }`, `count` = number of categories across
  `byLevel`, `byClassLevel`, `byRace`, `bySkill` and `byPvpRank` whose first holder (holders[0])
  is that character; only `count > 0`; ties by name.
- `skills`: for each profession id, the top 3 `{ name, class, skill }` by the skill in each current
  member's latest snapshot (ties by name); professions nobody has are omitted.

## UI

- Leaderboard first: a grid of four panels — Level standings (scrollable table: rank, name,
  class, race, level, +7d), Fastest this week, Most guild firsts, Profession skill (per
  profession, top 3 with skill). Empty panels say so ("No levels gained this week yet").
- Guild firsts: "Levels" group with one card per level 10–60 (overall holders); a "Class firsts"
  table with classes as rows and levels 10–60 as columns, each cell showing the first holder's
  name (or "—"); then Races (60), Professions, PvP ranks as today.
- Names link to the armory via `links` as today.
