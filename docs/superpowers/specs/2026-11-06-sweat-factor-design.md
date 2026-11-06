# Automatic Sweat Factor — Design

Date: 2026-11-06.

## Decisions (from brainstorming)

- The computed sweat factor **replaces** the self-reported one (Meh … World First).
- Alts are linked by hand: an "Alt of" field on the member edit form. Alts roll up into their
  main's score.
- Six tiers, hydration-themed: Bone Dry, Glistening, Damp, Drenched, Swamp Ass, Turbo Sweat.
- Hybrid scoring: bounded metrics as fractions, unbounded metrics as guild percentiles, activity
  (last seen) as a multiplier, fixed tier cutoffs.
- Dungeon, raid, reputation and quest data come from the Profile API's
  `/achievements/statistics` endpoint. Verified on Forever: the `encounters/*` endpoints return
  empty bodies, while statistics has "Total 5-player dungeons entered", per-boss kill counts
  named "<Boss> kills (<Instance>)", "Most <Faction> factions at Exalted", "Total factions
  encountered", and "Quests completed".

## Scoring

### Per-character metrics (normalized to 0–1)

| Category | Points | Metric | Normalization |
|---|---|---|---|
| Leveling | 20 | level | percentile |
| Gear | 10 | item level | percentile |
| Professions | 12 | mean of skill/300 over 5 slots (2 primary + 3 secondary; an unlearned slot is 0) | fraction |
| Professions | 8 | mean over learned primaries of known recipes ÷ catalog total for that profession (primaries absent from the catalog are skipped; none left → metric missing) | fraction |
| Dungeons & Raids | 7 | dungeons entered | percentile |
| Dungeons & Raids | 8 | boss weight: distinct dungeon bosses killed + 3 × distinct raid bosses killed | percentile |
| PvP | 6 | honorable kills | percentile |
| PvP | 4 | PvP rank ÷ 14 | fraction |
| Reputation | 5 | exalted + 0.1 × factions encountered | percentile |
| Legacy | 10 | Legacy points earned (account-wide) | percentile |
| Questing | 10 | quests completed | percentile |

Total: 100.

- **Percentile** = (number of guild characters with a known value ≤ this value) ÷ (number of
  guild characters with a known value). It is computed over every current guild character,
  alts included. A value of 0 always scores 0.
- **Missing metric** (e.g. the statistics call failed): the metric is left out, and the
  character's remaining weights are scaled up to total 100.
- A character whose armory has never been read (`armory === null`) is left out entirely: it isn't
  in any percentile population and adds nothing to its player. A player with no read character
  has no score.

### Players (main + alts)

- A player is a main (any member whose `altOf` is null) plus the members whose `altOf` points
  at it.
- For each metric, the player value is the highest character value plus 0.25 × the sum of the
  other characters' values, capped at 1. Missing values are skipped; the metric is missing for
  the player only if it is missing on every character.
- Legacy is account-wide: the player value is the highest character value, with no alt bonus.
- Base score = Σ(weight × player value), with weights rescaled for missing metrics as above.

### Activity multiplier

Days since the most recent `lastLogin` among the player's characters, measured against the
server's current time:

| Days since last login | Multiplier |
|---|---|
| ≤ 3 | 1.0 |
| ≤ 7 | 0.9 |
| ≤ 14 | 0.75 |
| ≤ 30 | 0.5 |
| older | 0.25 |
| unknown | 1.0 |

Final score = round(base score × multiplier), from 0 to 100.

### Tiers

| Score | Tier id | Name |
|---|---|---|
| < 15 | `bone-dry` | Bone Dry |
| 15–34 | `glistening` | Glistening |
| 35–54 | `damp` | Damp |
| 55–71 | `drenched` | Drenched |
| 72–87 | `swamp-ass` | Swamp Ass |
| ≥ 88 | `turbo-sweat` | Turbo Sweat |

Every character in a player group shows the player's score and tier.

## Components

### Fetching — `src/armory.ts`

- `loadCharacter` adds one parallel call: `this.client.profile(`${base}/achievements/statistics`)`.
- `mapSweatStats(raw): SweatStats | null` walks every category and sub-category and reads
  statistics by name:
  - `dungeonsEntered`: "Total 5-player dungeons entered"
  - `questsCompleted`: "Quests completed"
  - `exalted`: the statistic whose name matches `/factions at Exalted$/`
  - `factionsEncountered`: "Total factions encountered"
  - `dungeonBossKills` / `raidBossKills`: the number of distinct statistics under the "Boss
    Kills" sub-category with quantity > 0. A kill counts as a raid kill when the instance in the
    trailing parentheses is in `CLASSIC_RAIDS`: Molten Core, Onyxia's Lair, Blackwing Lair,
    Zul'Gurub, Ruins of Ahn'Qiraj, Temple of Ahn'Qiraj, Naxxramas. Every other kill counts as a
    dungeon kill.
  - A statistic that isn't found reads as 0. A null response gives `null`.
- `CharacterInfo` gains `sweatStats: SweatStats | null`.
- The character cache key goes up to v9.

### Storage — `src/db.ts`

- `MemberArmory` gains `sweatStats: SweatStats | null` and `pvp: { rank, honorableKills } | null`.
  Both are filled by the guild sync from `CharacterInfo`. Older stored armory blobs lack these
  fields and read them as `null`.
- `members` gains `alt_of INTEGER` (nullable; holds a member id), added with `ALTER TABLE`
  like `surname` and `armory`.
- When `syncRoster` removes members, it sets `alt_of = NULL` on any remaining row that pointed
  at a removed id.
- The `sweat_factor` column stays in the schema but is no longer read or written, so a rollback
  to the previous release is still safe.
- `Member` loses `sweatFactor` and gains `altOf: number | null`.

### Validation — `src/validate.ts`

- `sweatFactor` is removed from `MemberDetails`.
- `altOf`: null, or an integer id of an existing member, subject to these rules:
  - not the member itself
  - the target's own `altOf` must be null
  - a member that other members point at can't become an alt

  Each rule has its own error message. Validation needs the member list, so the route passes it
  in.

### Scoring — `src/sweat.ts` (new)

```ts
export interface SweatResult {
  score: number;
  tier: string;                       // tier id
  breakdown: Record<SweatCategory, number>; // points per category after rescaling and multiplier, rounded to 1 decimal
  mainId: number;
}
export interface RecipeIndex { totals: Record<string, number>; professionOf: Map<number, string> }
export function computeSweat(members: Member[], recipes: RecipeIndex | null, now: number): Map<number, SweatResult>;
```

- A pure function; members without a score are left out of the map.
- `RecipeIndex` (built in `recipe-catalog.ts` by `recipeIndex(catalog)`, memoized per catalog) maps
  profession id → catalog `total` and recipe id → profession id, so known recipes can be counted per
  profession. `null` (no catalog, i.e. not Forever or not built yet) makes the recipe metric missing.

### Game data — `src/game-data.ts`

- `SWEAT_FACTORS` is replaced by `SWEAT_TIERS: { id, name, min }[]`.
- `/api/game-data` returns `sweatTiers` instead of `sweatFactors`.

### API

- `GET /api/members`: each member gets `altOf` and
  `sweat: { score, tier, breakdown, mainId, main: string } | null` (`main` is the main's full
  name).
- `PUT /api/members/:id` accepts `altOf` and no longer accepts `sweatFactor`.
- `GET /api/progress`: `leaderboard.sweat` holds the top 10 players by score (ties by main name)
  as `{ name, class, score, tier, alts: string[] }`, current members only.

### UI

- **Roster:** the Sweat Factor column shows the computed tier pill, with pill colours by tier
  index (`sweat-0` … `sweat-5`). The pill's `title` and an expandable detail list show the score
  and points per category. An alt's pill (`sweat.mainId !== id`) is suffixed "via <Main>". The
  column is sortable by score. Members with no score show
  "—".
- **Edit form:** the sweat dropdown is replaced by "Alt of". Its options are "—" plus every
  member that isn't an alt, excluding the member being edited.
- **Progress leaderboard:** a fifth panel, "Sweatiest": rank, name (with alts listed in muted
  text), tier pill, score. If empty, it says "No sweat measured yet".
- README: update the API table (`sweatFactor` → `altOf`; game-data lists sweat tiers).

## Testing

- `test/sweat.test.ts`:
  - percentile with ties, the zero rule, and a single-member guild
  - alt rollup: the 0.25 bonus, the cap at 1, Legacy using the max with no bonus
  - a missing metric rescaling the weights; a member with no data getting no score
  - each activity multiplier band
  - each tier boundary (14/15, 34/35, 54/55, 71/72, 87/88)
- `test/armory.test.ts`: `mapSweatStats` against a captured statistics fixture, including
  raid/dungeon classification and a null input.
- `test/validate.test.ts`: the `altOf` rules.
- `test/db.test.ts`: the `alt_of` migration; `alt_of` cleared when the main leaves.
- `test/api.test.ts` / `test/progress-api.test.ts`: the new `sweat` / `altOf` fields, the
  `PUT altOf` validation, and `leaderboard.sweat`.

## Out of scope

- Time played (`/played` is not in the API).
- Per-boss raid progression displays; raids only feed the score.
- Guessing alts automatically.
