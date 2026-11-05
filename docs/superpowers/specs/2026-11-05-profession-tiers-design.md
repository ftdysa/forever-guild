# Profession Tier Milestones — Design

Date: 2026-11-05. Builds on the leaderboard branch (`2026-11-05-leaderboard-design.md`).

## Decisions (from brainstorming)

- Skill milestones at the rank caps 75 / 150 / 225 / 300 (Apprentice, Journeyman, Expert,
  Artisan) for every profession in `PROFESSIONS`.
- Firsts per profession per tier (no per-class/race breakdown).
- Discord announces every new profession-tier first.
- Firsts board: a profession × tier table (rows = professions, columns 75/150/225/300, first
  holder per cell), replacing the 12 profession cards.

## Milestones

- `kind: "skill"`, `key: "<professionId>:<tier>"`, e.g. `alchemy:150`. Existing rows store the
  bare profession id for 300; `ProgressStore` migrates them once and idempotently:
  `UPDATE milestones SET key = key || ':300' WHERE kind = 'skill' AND instr(key, ':') = 0`.
- Detection and dating mirror the level milestones (deploy-safe): for each tier N the character
  meets, the comparison snapshot B is their latest earlier-day snapshot with armory data
  (`race` not null) whose skill for that profession is below N (missing = 0); A is their earliest
  snapshot after B.day with skill ≥ N (today's row at the latest). If B exists the crossing is
  `observed`, dated by last login when it falls in [B.day 00:00Z, end of A.day] (and ≤ now), else
  `${A.day}T00:00:00.000Z`; its crossing day is A.day. If B doesn't exist, the first-sighting rules
  apply (launch member → achievement if any, else `before_tracking`; newcomer → `before_joining`).
- Only crossings whose crossing day is within the existing 2-day freshness window are announced,
  and each category is announced at most once (existing rules).
- Backfill: Forever's Legacy achievements "Journeyman / Expert / Artisan <crafter>" (150 / 225 /
  300) exist for Alchemy, Blacksmithing, Enchanting, Engineering, Leatherworking and Tailoring.
  `milestoneOf` maps all three; other professions/tiers have no backfill. The cached Legacy
  definitions and character entries change shape, so their cache keys are bumped.

## Firsts shape

`bySkill: Record<professionId, Record<"75"|"150"|"225"|"300", Category>>` (every profession ×
every tier). `mostFirsts` counts each profession-tier category.

Claim label: `First to reach <tier> <Profession>` (e.g. `First to reach 150 Alchemy`), unchanged
format for 300.

## UI

"Professions" group becomes a table like Class firsts: rows = professions (game order), columns
75 / 150 / 225 / 300, each cell the first holder (class-coloured, linked) or "—", full name in a
title. Same layout rules as the class table (fixed columns, horizontal scroll on phones).
