# Profession Tier Milestones Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Profession firsts at 75 / 150 / 225 / 300, deploy-safe, announced on Discord, shown as a profession × tier table.

**Spec:** `docs/superpowers/specs/2026-11-05-profession-tiers-design.md` (authoritative).

## Global Constraints

- Tests: `npm test`; single file `NODE_ENV=test node --import tsx --test test/<file>.test.ts`; `npm run lint` and `npm run typecheck` clean at the end of every task.
- CSP: no inline `style="..."`, no inline scripts, no libraries. Every data-derived string/attribute in markup goes through `esc()`.
- Skill milestone keys: `"<professionId>:<tier>"`, tiers `75`, `150`, `225`, `300`.
- Deploy safety: historical crossings must be dated from snapshot history and never announced unless within the 2-day freshness window; each category announced at most once.
- Commit trailers name the model that wrote the commit.

---

### Task 1: Skill tier milestones (server)

**Files:** `src/milestones.ts`, `src/progress.ts`, `src/progress-store.ts`, `src/armory.ts`, `src/progress-report.ts` (mostFirsts over the new shape), tests (`test/milestones.test.ts`, `test/progress-recorder.test.ts`, `test/progress-store.test.ts`, `test/armory.test.ts`, `test/progress-report.test.ts`, `test/guild-sync.test.ts` as needed), and `public/progress.js` + `test/progress-ui.test.ts` only minimally to keep the page working with the new `bySkill` shape (Task 2 redesigns the view).

- [ ] `SKILL_TIERS = [75, 150, 225, 300]`; `milestonesMet` returns, per profession in `PROFESSIONS` order, every tier ≤ the skill.
- [ ] Generalize the level "bracket" inputs so skills use the same mechanism (spec "Milestones"): per met skill milestone, the comparison snapshot B (latest earlier-day snapshot with race set and skill < N) and A (earliest snapshot after B.day with skill ≥ N). Keep `detectMilestones`/`crossingDay` pure; the recorder computes the brackets (a store method returning the character's snapshot history is fine; skills live in JSON, so filter in TS). PvP keeps its current behaviour.
- [ ] Store migration of existing skill keys (spec SQL), idempotent, run in the `ProgressStore` constructor.
- [ ] `Firsts.bySkill` per spec; `claimedFirsts` label `First to reach <tier> <Profession>`; `mostFirsts` counts profession-tier categories.
- [ ] Armory: `milestoneOf` maps Journeyman/Expert/Artisan <crafter> → `skill`, `<prof>:150|225|300`; bump the Legacy definitions cache key and the character cache key.
- [ ] Tests (TDD): milestonesMet tiers; observed tier crossing dated by last login and announced (`First to reach 150 Alchemy`); deploy regression — history 60→160→230 over earlier days, first post-deploy armory read records 75/150/225 observed with snapshot-history dates and announces nothing older than 2 days; launch member backfilled from a Journeyman achievement; newcomer before_joining; store key migration (bare `alchemy` → `alchemy:300`, idempotent); milestoneOf mappings; mostFirsts counts tiers.
- [ ] `npm test && npm run lint && npm run typecheck`; commit `feat: profession tier milestones`.

### Task 2: Profession × tier table (UI)

**Files:** `public/progress.js`, `public/style.css`, `test/progress-ui.test.ts`, `README.md`.

- [ ] Pure, tested: `professionTierTable(firsts, game)` → `{ tiers: string[], rows: { professionId, name, cells: (Holder | null)[] }[] }` (game order); `firstsGroups` no longer emits the Professions card group.
- [ ] Render the table after Class firsts, reusing the class-firsts table styles (fixed columns, `.firsts-scroll` horizontal scroll on phones, names linked via `who()` with class colour, full name in `title`).
- [ ] README: profession firsts at 75/150/225/300 (backfilled from Journeyman/Expert/Artisan achievements on Forever).
- [ ] `npm test && npm run lint && npm run typecheck`; commit `feat: profession tier firsts table`.
- [ ] Controller: browser check on a scratch DB.
