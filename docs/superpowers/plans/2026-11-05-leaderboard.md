# Leveling Milestones and Leaderboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add level 10/20/30/40/50 milestones (overall + per-class firsts) and a four-panel leaderboard to the Progress tab.

**Architecture:** Extend the pure milestone logic (`src/milestones.ts`) and recorder (`src/progress.ts`); add the leaderboard to `buildProgress` (`src/progress-report.ts`); render it in `public/progress.js`. No schema change.

**Spec:** `docs/superpowers/specs/2026-11-05-leaderboard-design.md` (authoritative for every value below).

## Global Constraints

- Tests: `npm test`; single file `NODE_ENV=test node --import tsx --test test/<file>.test.ts`; `npm run lint` and `npm run typecheck` clean at the end of every task.
- CSP: no inline `style="..."`, no inline scripts, no libraries; SVG presentation attributes are fine. Every data-derived string/attribute in markup goes through `esc()`.
- Days are UTC `YYYY-MM-DD`; timestamps ISO strings.
- Level milestone keys: `"10"`, `"20"`, `"30"`, `"40"`, `"50"`, `"60"`.
- Discord: only `observed` milestones; lower levels announce the overall first only.
- History keys are progress names (`progressName(characterName, surname)`).
- Commit trailers name the model that wrote the commit.

---

### Task 1: Level milestones every 10 levels

**Files:** `src/milestones.ts`, `src/progress.ts`, `test/milestones.test.ts`, `test/progress-recorder.test.ts`, `test/progress-report.test.ts` (shape updates), `public/progress.js` + `test/progress-ui.test.ts` only as needed to keep the build green (see below).

- [ ] Export `LEVEL_MILESTONES = [10, 20, 30, 40, 50, 60]`. `milestonesMet` returns every level milestone ≤ current level (ascending), then skills, then PvP ranks (order otherwise unchanged).
- [ ] `DetectInput.priorBelowLevel` becomes `Record<string, Snapshot | null>` keyed by level key: for each level threshold, the latest earlier-day snapshot with level below it. `comparison(kind, key, i)` uses `i.priorBelowLevel[key] ?? null` for levels. The recorder fills it with `store.latestBelowLevel(name, day, n)` for each `n` in `LEVEL_MILESTONES` the character currently meets (others may be omitted).
- [ ] Achievement backfill is unchanged (only key `"60"` has one).
- [ ] `Firsts` per the spec: replace `overall60`/`byClass` with `byLevel` and `byClassLevel`; keep `byRace` (60 only), `bySkill`, `byPvpRank`. `byClassLevel` has every class id × every level key.
- [ ] `claimedFirsts`: level N → `First to reach level N` when it leads `byLevel[N]`; for N = 60 only, also the class and race labels as today.
- [ ] Update `public/progress.js` `firstsGroups` minimally so it reads `byLevel["60"]` where it read `overall60` and `byClassLevel[c][ "60"]` where it read `byClass[c]` (Task 3 redesigns this view; this step only keeps the page and tests working). Update `test/progress-ui.test.ts` fixtures to the new shape.
- [ ] Tests (TDD — write first, see fail):
  - milestonesMet at level 37 → level 10, 20, 30 (plus skills/PvP as before).
  - A character at 29 on an earlier day and 31 today → `level:30` observed (dated by last login); 10 and 20 already recorded are not re-added.
  - A launch member first seen at 35 → 10, 20, 30 `before_tracking`; a newcomer → `before_joining`.
  - Recorder: day 1 roster+armory at 19; day 2 roster at 21 + armory → `level/20` observed and Discord claims `["First to reach level 20"]` only (no class claim); a level-60 ding still claims overall + class + race.
  - computeFirsts: `byLevel` has keys 10–60; `byClassLevel.warrior["30"]` holds the earliest warrior to 30.
- [ ] `npm test && npm run lint && npm run typecheck`; commit `feat: level milestones every 10 levels`.

### Task 2: Leaderboard in /api/progress

**Files:** `src/progress-report.ts`, `src/routes/progress.ts`, `test/progress-report.test.ts`, `test/progress-api.test.ts`.

- [ ] `buildProgress(snapshots, milestones, members, today: string)`; the route passes `utcDay(Date.now())`.
- [ ] Add `leaderboard: { standings, fastest, mostFirsts, skills }` to `ProgressReport`, exactly as the spec's Leaderboard section defines (current members only; ordering and tie-breaks; `gained7d` baseline rule; top-10 / top-3 limits; omit professions nobody has).
- [ ] Tests (TDD): standings order incl. tie on level broken by reachedOn then name; former members excluded; `gained7d` with a snapshot exactly 7 days back, with only newer history (baseline = earliest), and 0 when unchanged; `fastest` excludes 0 gains and caps at 10; `mostFirsts` counts across all five category groups and excludes former members; `skills` top 3 per profession from latest snapshots, omitting empty professions. Route test: response has `leaderboard` with the four keys.
- [ ] `npm test && npm run lint && npm run typecheck`; commit `feat: progress leaderboard`.

### Task 3: Leaderboard and level-firsts UI

**Files:** `public/progress.js`, `public/index.html`, `public/style.css`, `test/progress-ui.test.ts`, `README.md`.

- [ ] Pure, tested: `firstsGroups(firsts, game)` returns groups in order Levels (cards for 10–60, title `Level N`), Races, Professions, PvP ranks; plus a new export `classLevelTable(firsts, game)` → `{ levels: string[], rows: { classId, name, cells: (Holder | null)[] }[] }` (first holder per cell, classes in game order).
- [ ] Render (in `renderProgress`): a `#leaderboard` section above the level race with the four panels from the spec (standings table scrolls within a max height; empty-state messages); the "Class firsts" table after the Levels group. Names via the existing `who()` link helper; class colours via `paintClasses`. Add the needed containers to `index.html` (leaderboard above "Level Race"), styles to `style.css` (responsive grid: four panels on wide screens, stacked on phones; no inline styles).
- [ ] README "Progress" section: mention level milestones every 10 levels and the leaderboard panels.
- [ ] `npm test && npm run lint && npm run typecheck`; commit `feat: leaderboard and level firsts on the Progress tab`.
- [ ] Controller: browser check on a scratch DB (Discord off) with synthetic history covering several levels.
