# Automatic Sweat Factor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the self-reported sweat factor with a computed 0–100 score and six hydration tiers, rolled up across hand-linked alts, shown on the roster and as a "Sweatiest" leaderboard panel.

**Architecture:** The armory adds one Profile API call (`/achievements/statistics`) mapped to `SweatStats`; the guild sync stores it (plus PvP) on `MemberArmory`. A pure `src/sweat.ts` scores every member from the stored roster (percentiles across the guild, fractions for bounded metrics, alt rollup, activity multiplier). Routes compute it on read: `/api/members` adds `sweat` per member, `/api/progress` adds `leaderboard.sweat`. Members get a nullable `alt_of` column edited from the drawer.

**Tech Stack:** TypeScript (Node 20, ESM), Fastify, better-sqlite3, `node:test`, vanilla JS frontend.

Spec: `docs/superpowers/specs/2026-11-06-sweat-factor-design.md`.

## Global Constraints

- Tier ids/names/min scores, in order: `bone-dry` Bone Dry 0, `glistening` Glistening 15, `damp` Damp 35, `drenched` Drenched 55, `swamp-ass` Swamp Ass 72, `turbo-sweat` Turbo Sweat 88.
- Weights (total 100): leveling 20; gear 10; professions 12 (skill) + 8 (recipes); dungeons 7 (entered) + 8 (boss weight); pvp 6 (HKs) + 4 (rank/14); reputation 5; legacy 10; questing 10.
- Alt share 0.25, capped at 1; Legacy uses the max with no alt bonus.
- Activity multiplier: ≤3 d 1.0, ≤7 d 0.9, ≤14 d 0.75, ≤30 d 0.5, older 0.25, unknown 1.0.
- `sweat_factor` column stays in the schema, unread and unwritten (rollback safety).
- Commands: `npm run lint`, `npm run typecheck`, `npm test`. Single test file: `npx tsx --test test/<file>.test.ts`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Per the user's CLAUDE.md: after writing code, run the code-simplifier agent on modified files before final verification (Task 6).

## File Map

| File | Change |
|---|---|
| `src/armory.ts` | `SweatStats`, `RawAchievementStatistics`, `CLASSIC_RAIDS`, `mapSweatStats`; `CharacterInfo.sweatStats`; statistics call; cache key v9 |
| `src/game-data.ts` | `SWEAT_FACTORS` → `SWEAT_TIERS` |
| `src/validate.ts` | `sweatFactor` → `altOf`; `altOfError` |
| `src/db.ts` | `MemberArmory.pvp/sweatStats`; `alt_of` column; `Member.altOf`; clear dangling `alt_of` |
| `src/guild-sync.ts` | store `pvp` and `sweatStats` |
| `src/discord.ts` | drop sweat from the join embed |
| `src/recipe-catalog.ts` | `RecipeIndex`, `recipeIndex()` |
| `src/sweat.ts` (new) | scoring, tiers, player groups, leaderboard |
| `src/progress-report.ts` | `Leaderboard.sweat`, `buildProgress(..., sweat)` |
| `src/routes/members.ts` | `guildSweat()`, `sweat` in responses, `altOf` checks |
| `src/routes/progress.ts` | pass sweat leaderboard |
| `public/app.js`, `public/index.html`, `public/style.css`, `public/progress.js` | roster pill + breakdown, sort, "Alt of" select, Sweatiest panel, tier 5 colour |
| `README.md` | API table and intro |
| tests | `test/armory.test.ts`, `test/game-data.test.ts`, `test/validate.test.ts`, `test/db.test.ts`, `test/discord.test.ts`, `test/guild-sync.test.ts`, `test/sweat.test.ts` (new), `test/api.test.ts`, `test/progress-api.test.ts` |

---

### Task 1: Read sweat stats from the armory

**Files:**
- Modify: `src/armory.ts`
- Test: `test/armory.test.ts`

**Interfaces:**
- Produces: `export interface SweatStats { dungeonsEntered: number; dungeonBossKills: number; raidBossKills: number; questsCompleted: number; exalted: number; factionsEncountered: number }`, `export function mapSweatStats(raw: RawAchievementStatistics | null): SweatStats | null`, `CharacterInfo.sweatStats: SweatStats | null`.

- [ ] **Step 1: Write the failing tests**

Add `mapSweatStats` to the import from `../src/armory.js` in `test/armory.test.ts`, then append:

```ts
// Trimmed from a live Forever response (suri-zeal, level 24), plus one raid kill and a zero-kill boss.
const STATISTICS = {
  categories: [
    {
      id: 130,
      name: "Character",
      statistics: [{ id: 1, name: "Times camped", quantity: 22 }],
      sub_categories: [
        { id: 147, name: "Reputation", statistics: [
          { id: 2, name: "Most Horde factions at Exalted", quantity: 4 },
          { id: 3, name: "Total factions encountered", quantity: 14 },
        ] },
      ],
    },
    {
      id: 14807,
      name: "Dungeons & Raids",
      statistics: [{ id: 4, name: "Total 5-player dungeons entered", quantity: 5 }],
      sub_categories: [
        { id: 14808, name: "Boss Kills", statistics: [
          { id: 5, name: "Rath'mael Kills (Ruins of Lordaeron)", quantity: 1 },
          { id: 6, name: "Bazzalan kills (Ragefire Chasm)", quantity: 1 },
          { id: 7, name: "Taragaman the Hungerer kills (Ragefire Chasm)", quantity: 0 },
          { id: 8, name: "Ragnaros kills (Molten Core)", quantity: 2 },
        ] },
      ],
    },
    { id: 133, name: "Quests", statistics: [{ id: 9, name: "Quests completed", quantity: 190 }] },
  ],
};

test("mapSweatStats reads dungeons, distinct boss kills, quests and reputation by name", () => {
  assert.deepEqual(mapSweatStats(STATISTICS), {
    dungeonsEntered: 5,
    dungeonBossKills: 2,
    raidBossKills: 1,
    questsCompleted: 190,
    exalted: 4,
    factionsEncountered: 14,
  });
  assert.deepEqual(mapSweatStats({ categories: [] }), {
    dungeonsEntered: 0, dungeonBossKills: 0, raidBossKills: 0, questsCompleted: 0, exalted: 0, factionsEncountered: 0,
  });
  assert.equal(mapSweatStats(null), null);
  assert.equal(mapSweatStats({}), null);
});

test("character carries sweat stats from the statistics endpoint, null when it is missing", async () => {
  const withStats = setup({ ...characterFixture(), [`${BASE}/jaina/achievements/statistics`]: STATISTICS });
  assert.equal((await withStats.armory.character("Jaina"))?.sweatStats?.questsCompleted, 190);
  const without = setup();
  assert.equal((await without.armory.character("Jaina"))?.sweatStats, null);
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npx tsx --test test/armory.test.ts`
Expected: FAIL — `mapSweatStats` is not exported.

- [ ] **Step 3: Implement**

In `src/armory.ts`, next to `Reputation`:

```ts
// Grind signals from the achievement statistics endpoint (dungeons, raids, quests, reputation).
export interface SweatStats {
  dungeonsEntered: number;
  // Distinct bosses killed at least once.
  dungeonBossKills: number;
  raidBossKills: number;
  questsCompleted: number;
  exalted: number;
  factionsEncountered: number;
}
```

Add `sweatStats: SweatStats | null;` to `CharacterInfo` after `pvp`.

With the raw shapes:

```ts
interface RawStatistic {
  name: string;
  quantity?: number;
}
interface RawStatisticCategory {
  name: string;
  statistics?: RawStatistic[];
  sub_categories?: RawStatisticCategory[];
}
export interface RawAchievementStatistics {
  categories?: RawStatisticCategory[];
}
```

After `mapReputations`:

```ts
// Boss kill statistics are named "<Boss> kills (<Instance>)"; these instances are raids.
export const CLASSIC_RAIDS = new Set([
  "Molten Core", "Onyxia's Lair", "Blackwing Lair", "Zul'Gurub", "Ruins of Ahn'Qiraj", "Temple of Ahn'Qiraj", "Naxxramas",
]);

// Statistics are read by name; one that isn't there reads as 0.
export function mapSweatStats(raw: RawAchievementStatistics | null): SweatStats | null {
  if (!raw?.categories) return null;
  const groups = raw.categories.flatMap((c) => [c, ...(c.sub_categories ?? [])]);
  const all = groups.flatMap((g) => g.statistics ?? []);
  const value = (match: (name: string) => boolean) => all.find((s) => match(s.name))?.quantity ?? 0;
  const bosses = groups
    .filter((g) => g.name === "Boss Kills")
    .flatMap((g) => g.statistics ?? [])
    .filter((s) => (s.quantity ?? 0) > 0);
  const instance = (name: string) => /\(([^)]+)\)\s*$/.exec(name)?.[1] ?? "";
  const raids = bosses.filter((s) => CLASSIC_RAIDS.has(instance(s.name))).length;
  return {
    dungeonsEntered: value((n) => n === "Total 5-player dungeons entered"),
    dungeonBossKills: bosses.length - raids,
    raidBossKills: raids,
    questsCompleted: value((n) => n === "Quests completed"),
    exalted: value((n) => /factions at Exalted$/.test(n)),
    factionsEncountered: value((n) => n === "Total factions encountered"),
  };
}
```

In `loadCharacter`, add `sweatStatistics` to the destructured `Promise.all` result (after `pvp`) with the call `this.client.profile<RawAchievementStatistics>(`${base}/achievements/statistics`),` placed after the pvp-summary call, and add `sweatStats: mapSweatStats(sweatStatistics),` to the returned object after `pvp`. Update the comment above `loadCharacter` from "up to eight profile calls" to "up to nine profile calls".

In `character()`, bump the key to `v9` and extend the comment: `...; v8 tiered skill milestone keys; v9 sweat stats.`

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npx tsx --test test/armory.test.ts`
Expected: PASS. Then `npm run typecheck` — fix any test fixture that builds a full `CharacterInfo` literal without `sweatStats` by adding `sweatStats: null` (casts with `as CharacterInfo` need nothing).

- [ ] **Step 5: Commit**

```bash
git add src/armory.ts test/armory.test.ts
git commit -m "feat: read dungeon, raid, quest and reputation statistics from the armory

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Data model — tiers, `altOf`, stored PvP and sweat stats; drop self-reported sweat

**Files:**
- Modify: `src/game-data.ts`, `src/validate.ts`, `src/db.ts`, `src/guild-sync.ts`, `src/discord.ts`
- Test: `test/game-data.test.ts`, `test/validate.test.ts`, `test/db.test.ts`, `test/discord.test.ts`, `test/guild-sync.test.ts`, `test/api.test.ts` (fixture only)

**Interfaces:**
- Consumes: `SweatStats` from Task 1.
- Produces: `SWEAT_TIERS: SweatTier[]` (`SweatTier = Choice & { min: number }`), `GameData.sweatTiers`; `MemberDetails.altOf: number | null` (replaces `sweatFactor`); `Member.altOf`; `MemberArmory.pvp: { rank: number; honorableKills: number } | null`, `MemberArmory.sweatStats: SweatStats | null`; `altOfError(memberId: number, altOf: number | null, members: { id: number; altOf: number | null }[]): string | null`.

- [ ] **Step 1: Write the failing tests**

`test/game-data.test.ts` — replace the `SWEAT_FACTORS` import with `SWEAT_TIERS`, and replace the sweat assertions:

```ts
test("sweat tiers and leveling prefs are ordered as specified", () => {
  assert.deepEqual(
    SWEAT_TIERS.map((t) => [t.id, t.name, t.min]),
    [
      ["bone-dry", "Bone Dry", 0],
      ["glistening", "Glistening", 15],
      ["damp", "Damp", 35],
      ["drenched", "Drenched", 55],
      ["swamp-ass", "Swamp Ass", 72],
      ["turbo-sweat", "Turbo Sweat", 88],
    ],
  );
  // keep the existing LEVELING_PREFS assertion from the old test here
});
```

and in the game-data shape test: `assert.equal(d.sweatTiers, SWEAT_TIERS);`.

`test/validate.test.ts`:
- In `good`, replace `sweatFactor: "sweaty"` with `altOf: 7`; in the normalized expectation replace `sweatFactor: "sweaty"` with `altOf: 7`; in "everything is optional" replace `sweatFactor: null` with `altOf: null`.
- Replace the "sweat factor and leveling pref are optional choices" test with:

```ts
test("leveling pref is an optional choice", () => {
  for (const empty of [undefined, null, ""]) {
    const r = validate({ ...good, levelingPref: empty });
    assert.ok(r.ok);
    assert.equal(r.value.levelingPref, null);
  }
  assert.ok(validate({ ...good, levelingPref: "orgy" }).ok);
});

test("altOf is a member id or empty", () => {
  for (const empty of [undefined, null, ""]) {
    const r = validate({ ...good, altOf: empty });
    assert.ok(r.ok);
    assert.equal(r.value.altOf, null);
  }
  for (const bad of ["7", 0, -1, 1.5, true]) {
    assert.ok(errorsOf({ ...good, altOf: bad }).includes("altOf must be a member id or null"), String(bad));
  }
});

test("altOfError allows one level of main → alt links", () => {
  const members = [
    { id: 1, altOf: null }, // main with an alt
    { id: 2, altOf: 1 }, // alt
    { id: 3, altOf: null }, // lone main
  ];
  assert.equal(altOfError(3, null, members), null);
  assert.equal(altOfError(3, 1, members), null);
  assert.equal(altOfError(3, 3, members), "a member cannot be their own alt");
  assert.equal(altOfError(3, 99, members), "altOf is not a guild member");
  assert.equal(altOfError(3, 2, members), "altOf must point at a main, not another alt");
  assert.equal(altOfError(1, 3, members), "a member with alts cannot become an alt");
});
```

- Update the import to `import { altOfError, validateDetails } from "../src/validate.js";`.
- In the "multiple errors" test (line ~89) replace `sweatFactor: "x"` with `altOf: "x"`.

`test/db.test.ts`:
- `details`: replace `sweatFactor: "world-first"` with `altOf: null`.
- `ARMORY`: append `pvp: null, sweatStats: null`.
- In the member shape expectation replace `sweatFactor: null,` with `altOf: null,`.
- Line ~216 `assert.equal(m.sweatFactor, null);` → `assert.equal(m.altOf, null);`.
- Append:

```ts
test("altOf is stored, and cleared when the main leaves the guild", () => {
  store.syncRoster([thrall, jaina]);
  const [j, t] = store.list();
  store.updateDetails(j.id, { ...details, altOf: t.id });
  assert.equal(store.get(j.id)?.altOf, t.id);
  store.syncRoster([jaina]);
  assert.equal(store.get(j.id)?.altOf, null);
});

test("an older members table gains alt_of and keeps its rows", () => {
  const old = openDatabase(":memory:");
  old.exec(`CREATE TABLE members (
    id INTEGER PRIMARY KEY AUTOINCREMENT, character_name TEXT NOT NULL COLLATE NOCASE, surname TEXT,
    main_class TEXT NOT NULL, main_spec TEXT, level INTEGER NOT NULL DEFAULT 0, guild_rank INTEGER NOT NULL DEFAULT 0,
    backup_class TEXT, backup_spec TEXT, primary_professions TEXT NOT NULL DEFAULT '[]',
    secondary_professions TEXT NOT NULL DEFAULT '[]', armory TEXT, sweat_factor TEXT, leveling_pref TEXT,
    notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  old.exec("INSERT INTO members (character_name, main_class, sweat_factor, created_at, updated_at) VALUES ('Thrall', 'shaman', 'sweaty', 'x', 'x')");
  const s = new MemberStore(old);
  assert.equal(s.list()[0].characterName, "Thrall");
  assert.equal(s.list()[0].altOf, null);
  old.close();
});

test("armory stored before sweat stats reads pvp and sweatStats as null", () => {
  store.syncRoster([thrall]);
  db.prepare("UPDATE members SET armory = ?").run(JSON.stringify({ race: null, skills: {}, recipes: [] }));
  const [m] = store.list();
  assert.equal(m.armory?.pvp, null);
  assert.equal(m.armory?.sweatStats, null);
});
```

`test/discord.test.ts`: replace `sweatFactor: "casual"` with `altOf: null` and `sweatFactor: null` with `altOf: null`; change the expected `["Style", "Casual · Duo"]` to `["Style", "Duo"]`.

`test/guild-sync.test.ts`: line ~103 replace `sweatFactor: null` with `altOf: null`.

`test/api.test.ts`: in `details` replace `sweatFactor: "casual"` with `altOf: null`; in the `applyArmory` call's armory literal append `pvp: null, sweatStats: null`; replace `assert.equal(updated.json().sweatFactor, "casual");` with `assert.equal(updated.json().altOf, null);`; change `assert.equal(res.json().sweatFactors.length, 5);` to `assert.equal(res.json().sweatTiers.length, 6);`.

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npm test`
Expected: FAIL on the new/changed assertions (`SWEAT_TIERS`, `altOfError` not exported, `altOf` undefined).

- [ ] **Step 3: Implement**

`src/game-data.ts` — replace `SWEAT_FACTORS`:

```ts
// Computed sweat tiers (src/sweat.ts), lowest first; a score at or above `min` reaches the tier.
export interface SweatTier extends Choice {
  min: number;
}

export const SWEAT_TIERS: SweatTier[] = [
  { id: "bone-dry", name: "Bone Dry", min: 0 },
  { id: "glistening", name: "Glistening", min: 15 },
  { id: "damp", name: "Damp", min: 35 },
  { id: "drenched", name: "Drenched", min: 55 },
  { id: "swamp-ass", name: "Swamp Ass", min: 72 },
  { id: "turbo-sweat", name: "Turbo Sweat", min: 88 },
];
```

and in `GameData` / its builder: `sweatTiers: SweatTier[];` and `sweatTiers: SWEAT_TIERS`.

`src/validate.ts`:
- Import: `import { findClass, findSpec, LEVELING_PREFS, type Choice } from "./game-data.js";`
- `MemberDetails`: replace `sweatFactor: string | null;` with `// Member id of this character's main; null for a main.\n  altOf: number | null;`
- Replace the `sweatFactor` parsing with:

```ts
  let altOf: number | null = null;
  if (raw.altOf !== undefined && raw.altOf !== null && raw.altOf !== "") {
    if (typeof raw.altOf === "number" && Number.isInteger(raw.altOf) && raw.altOf > 0) altOf = raw.altOf;
    else errors.push("altOf must be a member id or null");
  }
```

- Return value: replace `sweatFactor: sweatFactor.value` with `altOf`.
- Append:

```ts
// The alt link rules that need the roster: one level only (a main's alts can't have alts).
export function altOfError(memberId: number, altOf: number | null, members: { id: number; altOf: number | null }[]): string | null {
  if (altOf === null) return null;
  if (altOf === memberId) return "a member cannot be their own alt";
  const target = members.find((m) => m.id === altOf);
  if (!target) return "altOf is not a guild member";
  if (target.altOf !== null) return "altOf must point at a main, not another alt";
  if (members.some((m) => m.altOf === memberId)) return "a member with alts cannot become an alt";
  return null;
}
```

`src/db.ts`:
- `import type { Professions, RosterEntry, SweatStats } from "./armory.js";`
- `MemberArmory`: after `recipes`, add:

```ts
  // null until read, and on rows stored before these were kept.
  pvp: { rank: number; honorableKills: number } | null;
  sweatStats: SweatStats | null;
```

- `Row`: add `alt_of: number | null;`.
- `membersTable`: add `alt_of INTEGER,` after `leveling_pref TEXT,` (keep `sweat_factor TEXT,` — unused, kept so a rollback still works).
- Constructor, after the `surname`/`armory` loop: `if (!cols.includes("alt_of")) this.db.exec("ALTER TABLE members ADD COLUMN alt_of INTEGER");`
- `rowToMember`: replace `sweatFactor: r.sweat_factor,` with `altOf: r.alt_of,`, and replace the armory line with `armory: r.armory ? readArmory(r.armory) : null,` using:

```ts
// Rows stored before pvp and sweat stats were kept lack them. Filling them in place keeps key order,
// so applyArmory's JSON comparison still sees an unchanged snapshot as unchanged.
function readArmory(json: string): MemberArmory {
  const a = JSON.parse(json) as MemberArmory;
  return { ...a, pvp: a.pvp ?? null, sweatStats: a.sweatStats ?? null };
}
```

- `syncRoster`: after the `for (const gone of existing.values()) remove.run(gone.id);` line add:

```ts
      // An alt whose main left becomes a main again.
      this.db.prepare("UPDATE members SET alt_of = NULL WHERE alt_of IS NOT NULL AND alt_of NOT IN (SELECT id FROM members)").run();
```

- `updateDetails`: replace `sweat_factor = @sweatFactor` with `alt_of = @altOf`.

`src/guild-sync.ts` — in `snapshot()`, after `recipes: ...` add (order matters, see `readArmory`):

```ts
    pvp: c.pvp,
    sweatStats: c.sweatStats,
```

`src/discord.ts` — remove `SWEAT_FACTORS` from the import and the `m.sweatFactor && nameOf(SWEAT_FACTORS, m.sweatFactor),` line from `style`.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npm run typecheck && npm test`
Expected: PASS (the frontend still references `sweatFactors`; it is fixed in Task 5 and not covered by these tests).

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat: alt links and stored sweat stats; retire the self-reported sweat factor

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Scoring module

**Files:**
- Create: `src/sweat.ts`
- Modify: `src/recipe-catalog.ts`
- Test: `test/sweat.test.ts` (new), `test/recipe-catalog.test.ts`

**Interfaces:**
- Consumes: `Member`, `MemberArmory` (Task 2), `SWEAT_TIERS` (Task 2), `progressName` from `src/progress.ts`, `Catalog` from `src/recipe-catalog.ts`.
- Produces:
  - `src/recipe-catalog.ts`: `export interface RecipeIndex { totals: Record<string, number>; professionOf: Map<number, string> }`, `export function recipeIndex(catalog: Catalog): RecipeIndex`.
  - `src/sweat.ts`: `type SweatCategory`, `SWEAT_CATEGORIES`, `interface SweatResult { score: number; tier: string; breakdown: Record<SweatCategory, number>; mainId: number }`, `interface SweatEntry { name: string; class: string; score: number; tier: string; alts: string[] }`, `computeSweat(members: Member[], recipes: RecipeIndex | null, now: number): Map<number, SweatResult>`, `activityMultiplier(lastLogin: string | null, now: number): number`, `tierFor(score: number): string`, `playerGroups(members: Member[]): Map<number, Member[]>`, `sweatLeaderboard(members: Member[], results: Map<number, SweatResult>, limit?: number): SweatEntry[]`.

- [ ] **Step 1: Write the failing tests**

Append to `test/recipe-catalog.test.ts` (add `recipeIndex` to its import from `../src/recipe-catalog.js`; `Catalog` type import too if not already):

```ts
test("recipeIndex maps professions to totals and recipes to professions, once per catalog", () => {
  const catalog = {
    professions: [
      { id: "alchemy", name: "Alchemy", total: 2, categories: [{ name: "Potions", recipes: [{ id: 1 }, { id: 2 }] }] },
      { id: "cooking", name: "Cooking", total: 1, categories: [{ name: "Food", recipes: [{ id: 9 }] }] },
    ],
  } as unknown as Catalog;
  const index = recipeIndex(catalog);
  assert.deepEqual(index.totals, { alchemy: 2, cooking: 1 });
  assert.deepEqual([...index.professionOf], [[1, "alchemy"], [2, "alchemy"], [9, "cooking"]]);
  assert.equal(recipeIndex(catalog), index);
});
```

Create `test/sweat.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Member, MemberArmory } from "../src/db.js";
import { activityMultiplier, computeSweat, sweatLeaderboard, tierFor } from "../src/sweat.js";

const NOW = Date.UTC(2026, 10, 6);
const DAY = 86_400_000;
const today = new Date(NOW).toISOString();

// A member read from the armory with nothing known but their level (and a login today).
function member(id: number, over: Partial<Member> = {}, armory: Partial<MemberArmory> | null = {}): Member {
  return {
    id,
    characterName: `C${id}`,
    surname: null,
    mainClass: "warrior",
    mainSpec: null,
    level: 10,
    guildRank: 0,
    backupClass: null,
    backupSpec: null,
    altOf: null,
    levelingPref: null,
    notes: "",
    primaryProfessions: [],
    secondaryProfessions: [],
    createdAt: "",
    updatedAt: "",
    armory:
      armory === null
        ? null
        : {
            race: null, gender: null, faction: null, title: null, itemLevel: null, lastLogin: today,
            achievementPoints: null, legacy: null, skills: {}, recipes: [], pvp: null, sweatStats: null,
            ...armory,
          },
    ...over,
  };
}

const score = (members: Member[], id: number) => computeSweat(members, null, NOW).get(id)?.score;

test("missing metrics are dropped and the rest rescaled to 100", () => {
  // Known: level (20, top of a guild of one) and profession skill (12, none learned) → 20/32.
  const r = computeSweat([member(1)], null, NOW).get(1);
  assert.equal(r?.score, 63);
  assert.equal(r?.tier, "drenched");
  assert.equal(r?.mainId, 1);
  assert.deepEqual(r?.breakdown, { leveling: 62.5, gear: 0, professions: 0, dungeons: 0, pvp: 0, reputation: 0, legacy: 0, questing: 0 });
});

test("percentiles are inclusive across the guild", () => {
  const guild = [member(1, { level: 10 }), member(2, { level: 20 }), member(3, { level: 20 })];
  // Level 10 is at or above 1 of 3: 20 × 1/3 of 32 known points.
  assert.equal(score(guild, 1), 21);
  assert.equal(score(guild, 2), 63);
  assert.equal(score(guild, 3), 63);
});

test("a zero value scores 0 even when everyone else is also low", () => {
  const guild = [member(1, {}, { legacy: { earned: 0, total: 65 } }), member(2, {}, { legacy: { earned: 2, total: 65 } })];
  // Known: level 20 + skill 12 + legacy 10 = 42.
  assert.equal(score(guild, 1), 48); // 20/42
  assert.equal(score(guild, 2), 71); // 30/42
});

test("every metric is read and weighted", () => {
  const all = member(1, { level: 30, primaryProfessions: ["mining"] }, {
    itemLevel: 20,
    skills: { mining: { skill: 300, max: 300 } },
    pvp: { rank: 7, honorableKills: 5 },
    legacy: { earned: 3, total: 65 },
    sweatStats: { dungeonsEntered: 3, dungeonBossKills: 2, raidBossKills: 0, questsCompleted: 50, exalted: 0, factionsEncountered: 10 },
  });
  // Recipes unknown (no catalog) → 92 known points; 80.4 earned:
  // 20 + 10 + 12×0.2 + 7 + 8 + 6 + 4×0.5 + 5 + 10 + 10.
  const r = computeSweat([all], null, NOW).get(1);
  assert.equal(r?.score, 87);
  assert.equal(r?.tier, "swamp-ass");
  assert.equal(r?.breakdown.dungeons, 16.3);
  assert.equal(r?.breakdown.pvp, 8.7);
  assert.equal(r?.breakdown.professions, 2.6);
});

test("recipes count against the catalog total of each learned primary", () => {
  const recipes = { totals: { alchemy: 4 }, professionOf: new Map([[1, "alchemy"], [2, "alchemy"], [9, "cooking"]]) };
  // Herbalism has no catalog entry, so only alchemy counts: 2 of 4 known.
  const m = member(1, { primaryProfessions: ["alchemy", "herbalism"] }, { recipes: [1, 2, 9] });
  // Known: level 20 + skill 12 + recipes 8 = 40; earned 20 + 0 + 4.
  assert.equal(computeSweat([m], recipes, NOW).get(1)?.score, 60);
});

test("alts add a quarter of their values to their main, capped at 1", () => {
  const main = member(1, { level: 20, primaryProfessions: ["mining"] }, { skills: { mining: { skill: 150, max: 225 } } });
  const alt = member(2, { level: 10, altOf: 1, primaryProfessions: ["herbalism"] }, { skills: { herbalism: { skill: 300, max: 300 } } });
  const other = member(3, { level: 20 });
  const results = computeSweat([main, alt, other], null, NOW);
  // Skill: best 0.2 (alt) + 0.25 × 0.1 (main) = 0.225. Level: 1 + 0.25 × 1/3, capped at 1.
  assert.equal(results.get(1)?.score, 71);
  assert.equal(results.get(1)?.breakdown.leveling, 62.5);
  assert.equal(results.get(1)?.breakdown.professions, 8.4);
  assert.deepEqual(results.get(2), results.get(1));
  assert.equal(results.get(2)?.mainId, 1);
  assert.equal(results.get(3)?.score, 63);
});

test("legacy is account-wide: the best character counts, alts add nothing", () => {
  const guild = [
    member(1, {}, { legacy: { earned: 2, total: 65 } }),
    member(2, { altOf: 1 }, { legacy: { earned: 2, total: 65 } }),
    member(3, {}, { legacy: { earned: 4, total: 65 } }),
  ];
  // Legacy 2 is at or above 2 of 3 → 2/3 of 10, with no alt bonus: (20 + 6.67) / 42.
  assert.equal(score(guild, 1), 63);
  assert.equal(score(guild, 3), 71);
});

test("members never read from the armory have no score unless their main does", () => {
  assert.equal(computeSweat([member(1, {}, null)], null, NOW).size, 0);
  const results = computeSweat([member(1), member(2, { altOf: 1 }, null)], null, NOW);
  assert.equal(results.get(2)?.score, 63);
  assert.equal(results.get(2)?.mainId, 1);
});

test("the activity multiplier follows the player's most recent login", () => {
  const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
  assert.equal(activityMultiplier(null, NOW), 1);
  assert.equal(activityMultiplier(ago(3), NOW), 1);
  assert.equal(activityMultiplier(ago(3.5), NOW), 0.9);
  assert.equal(activityMultiplier(ago(7), NOW), 0.9);
  assert.equal(activityMultiplier(ago(8), NOW), 0.75);
  assert.equal(activityMultiplier(ago(14), NOW), 0.75);
  assert.equal(activityMultiplier(ago(20), NOW), 0.5);
  assert.equal(activityMultiplier(ago(30), NOW), 0.5);
  assert.equal(activityMultiplier(ago(31), NOW), 0.25);
  // 62.5 × 0.75
  assert.equal(score([member(1, {}, { lastLogin: ago(10) })], 1), 47);
  // An alt played today keeps the player fresh.
  assert.equal(score([member(1, {}, { lastLogin: ago(40) }), member(2, { altOf: 1 }, null), member(3, { altOf: 1 })], 1), 63);
});

test("tiers start at their minimum score", () => {
  const cases: [number, string][] = [
    [0, "bone-dry"], [14, "bone-dry"], [15, "glistening"], [34, "glistening"], [35, "damp"], [54, "damp"],
    [55, "drenched"], [71, "drenched"], [72, "swamp-ass"], [87, "swamp-ass"], [88, "turbo-sweat"], [100, "turbo-sweat"],
  ];
  for (const [s, tier] of cases) assert.equal(tierFor(s), tier, String(s));
});

test("the sweat leaderboard ranks players by score and lists their alts", () => {
  const guild = [
    member(1, { characterName: "Thrall", surname: "Durotan", mainClass: "shaman", level: 20 }),
    member(2, { characterName: "Rexxar", altOf: 1, mainClass: "hunter" }),
    member(3, { characterName: "Jaina", mainClass: "mage" }),
  ];
  assert.deepEqual(sweatLeaderboard(guild, computeSweat(guild, null, NOW)), [
    { name: "Thrall Durotan", class: "shaman", score: 63, tier: "drenched", alts: ["Rexxar"] },
    { name: "Jaina", class: "mage", score: 42, tier: "damp", alts: [] },
  ]);
});
```

Note the third login case: member 3 is an alt of 1 with a login today, so the player's latest login is today. Member 2 (no armory) contributes nothing. Level population is [10, 10] → each 1; skill 0 → 63.

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npx tsx --test test/sweat.test.ts test/recipe-catalog.test.ts`
Expected: FAIL — `src/sweat.ts` doesn't exist; `recipeIndex` not exported.

- [ ] **Step 3: Implement**

Append to `src/recipe-catalog.ts`:

```ts
// What the sweat score needs from the catalog: recipes per profession, and each recipe's profession.
export interface RecipeIndex {
  totals: Record<string, number>;
  professionOf: Map<number, string>;
}

const indexes = new WeakMap<Catalog, RecipeIndex>();

// Built once per catalog object (RecipeCatalog.current() returns the same object until a rebuild).
export function recipeIndex(catalog: Catalog): RecipeIndex {
  let index = indexes.get(catalog);
  if (!index) {
    const professionOf = new Map<number, string>();
    for (const p of catalog.professions) for (const c of p.categories) for (const r of c.recipes) professionOf.set(r.id, p.id);
    index = { totals: Object.fromEntries(catalog.professions.map((p) => [p.id, p.total])), professionOf };
    indexes.set(catalog, index);
  }
  return index;
}
```

Optionally make `craftersByRecipe` use `recipeIndex(catalog).professionOf` instead of building its own map (DRY).

Create `src/sweat.ts`:

```ts
import type { Member, MemberArmory } from "./db.js";
import { SWEAT_TIERS } from "./game-data.js";
import { progressName } from "./progress.js";
import type { RecipeIndex } from "./recipe-catalog.js";

// The computed sweat factor: how hard each player (a main plus its alts) is playing, 0–100.
// See docs/superpowers/specs/2026-11-06-sweat-factor-design.md.

export type SweatCategory = "leveling" | "gear" | "professions" | "dungeons" | "pvp" | "reputation" | "legacy" | "questing";
export const SWEAT_CATEGORIES: SweatCategory[] = ["leveling", "gear", "professions", "dungeons", "pvp", "reputation", "legacy", "questing"];

export interface SweatResult {
  score: number;
  tier: string;
  // Points per category, after rescaling and the activity multiplier, to one decimal.
  breakdown: Record<SweatCategory, number>;
  mainId: number;
}

export interface SweatEntry {
  name: string;
  class: string;
  score: number;
  tier: string;
  alts: string[];
}

type Read = (m: Member, armory: MemberArmory, recipes: RecipeIndex | null) => number | null;

interface Metric {
  category: SweatCategory;
  weight: number;
  // percentile: share of the guild at or below the value. fraction: the value is already 0–1.
  scale: "percentile" | "fraction";
  // Account-wide values are the same on every character: the best one counts, alts add nothing.
  accountWide?: boolean;
  read: Read;
}

const MAX_SKILL = 300;
const PROFESSION_SLOTS = 5; // 2 primary + 3 secondary
const MAX_PVP_RANK = 14;
const ALT_SHARE = 0.25;
const DAY_MS = 86_400_000;

function skillFraction(m: Member, a: MemberArmory): number {
  const total = [...m.primaryProfessions, ...m.secondaryProfessions].reduce(
    (sum, p) => sum + Math.min(a.skills[p]?.skill ?? 0, MAX_SKILL) / MAX_SKILL,
    0,
  );
  return total / PROFESSION_SLOTS;
}

// Mean over learned primaries in the catalog of known ÷ total recipes; null if none qualify.
function recipeFraction(m: Member, a: MemberArmory, recipes: RecipeIndex | null): number | null {
  if (!recipes) return null;
  const learned = m.primaryProfessions.filter((p) => (recipes.totals[p] ?? 0) > 0);
  if (learned.length === 0) return null;
  const known = new Map<string, number>();
  for (const id of a.recipes ?? []) {
    const p = recipes.professionOf.get(id);
    if (p) known.set(p, (known.get(p) ?? 0) + 1);
  }
  return learned.reduce((sum, p) => sum + Math.min(1, (known.get(p) ?? 0) / recipes.totals[p]), 0) / learned.length;
}

const METRICS: Metric[] = [
  { category: "leveling", weight: 20, scale: "percentile", read: (m) => m.level },
  { category: "gear", weight: 10, scale: "percentile", read: (_m, a) => a.itemLevel },
  { category: "professions", weight: 12, scale: "fraction", read: skillFraction },
  { category: "professions", weight: 8, scale: "fraction", read: recipeFraction },
  { category: "dungeons", weight: 7, scale: "percentile", read: (_m, a) => a.sweatStats?.dungeonsEntered ?? null },
  {
    category: "dungeons",
    weight: 8,
    scale: "percentile",
    read: (_m, a) => (a.sweatStats ? a.sweatStats.dungeonBossKills + 3 * a.sweatStats.raidBossKills : null),
  },
  { category: "pvp", weight: 6, scale: "percentile", read: (_m, a) => a.pvp?.honorableKills ?? null },
  { category: "pvp", weight: 4, scale: "fraction", read: (_m, a) => (a.pvp ? Math.min(a.pvp.rank, MAX_PVP_RANK) / MAX_PVP_RANK : null) },
  {
    category: "reputation",
    weight: 5,
    scale: "percentile",
    read: (_m, a) => (a.sweatStats ? a.sweatStats.exalted + 0.1 * a.sweatStats.factionsEncountered : null),
  },
  { category: "legacy", weight: 10, scale: "percentile", accountWide: true, read: (_m, a) => a.legacy?.earned ?? null },
  { category: "questing", weight: 10, scale: "percentile", read: (_m, a) => a.sweatStats?.questsCompleted ?? null },
];

// Inclusive percentile among the known values; 0 always scores 0 (nobody exalted ≠ everyone tops it).
function percentile(value: number, population: number[]): number {
  if (value <= 0) return 0;
  return population.filter((v) => v <= value).length / population.length;
}

export function activityMultiplier(lastLogin: string | null, now: number): number {
  if (!lastLogin) return 1;
  const days = (now - Date.parse(lastLogin)) / DAY_MS;
  if (days <= 3) return 1;
  if (days <= 7) return 0.9;
  if (days <= 14) return 0.75;
  if (days <= 30) return 0.5;
  return 0.25;
}

export function tierFor(score: number): string {
  let tier = SWEAT_TIERS[0].id;
  for (const t of SWEAT_TIERS) if (score >= t.min) tier = t.id;
  return tier;
}

// Main id → the main followed by its alts. A link to a missing member or to another alt is
// ignored (validation prevents both), leaving that character as its own main.
export function playerGroups(members: Member[]): Map<number, Member[]> {
  const byId = new Map(members.map((m) => [m.id, m]));
  const mainOf = (m: Member) => {
    const main = m.altOf === null ? undefined : byId.get(m.altOf);
    return main && main.altOf === null ? main.id : m.id;
  };
  const groups = new Map<number, Member[]>();
  for (const m of members) if (mainOf(m) === m.id) groups.set(m.id, [m]);
  for (const m of members) if (mainOf(m) !== m.id) groups.get(mainOf(m))?.push(m);
  return groups;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

// Scores every player; each of their characters maps to the same result. Members never read
// from the armory are left out of every population; a player with none read has no entry.
export function computeSweat(members: Member[], recipes: RecipeIndex | null, now: number): Map<number, SweatResult> {
  const read = members.filter((m): m is Member & { armory: MemberArmory } => m.armory !== null);
  // Per metric: character id → normalized 0–1 value, or null when unknown.
  const normalized = METRICS.map((metric) => {
    const raw = new Map(read.map((m) => [m.id, metric.read(m, m.armory, recipes)]));
    const population = [...raw.values()].filter((v): v is number => v !== null);
    return new Map(
      [...raw].map(([id, v]) => [id, v === null ? null : metric.scale === "fraction" ? v : percentile(v, population)]),
    );
  });

  const out = new Map<number, SweatResult>();
  for (const [mainId, group] of playerGroups(members)) {
    const values = METRICS.map((metric, i) => {
      const vals = group
        .map((m) => normalized[i].get(m.id))
        .filter((v): v is number => typeof v === "number")
        .sort((a, b) => b - a);
      if (vals.length === 0) return null;
      if (metric.accountWide) return vals[0];
      return Math.min(1, vals[0] + ALT_SHARE * vals.slice(1).reduce((s, v) => s + v, 0));
    });
    const known = METRICS.reduce((s, metric, i) => s + (values[i] === null ? 0 : metric.weight), 0);
    if (known === 0) continue;
    const lastLogin =
      group
        .map((m) => m.armory?.lastLogin ?? null)
        .filter((d): d is string => d !== null)
        .sort()
        .pop() ?? null;
    const scale = (100 / known) * activityMultiplier(lastLogin, now);
    const breakdown = Object.fromEntries(SWEAT_CATEGORIES.map((c) => [c, 0])) as Record<SweatCategory, number>;
    let total = 0;
    METRICS.forEach((metric, i) => {
      const v = values[i];
      if (v === null) return;
      const points = metric.weight * v * scale;
      breakdown[metric.category] += points;
      total += points;
    });
    for (const c of SWEAT_CATEGORIES) breakdown[c] = round1(breakdown[c]);
    const score = Math.round(total);
    const result = { score, tier: tierFor(score), breakdown, mainId };
    for (const m of group) out.set(m.id, result);
  }
  return out;
}

// Top players by score (ties by name), named like the rest of the progress tab.
export function sweatLeaderboard(members: Member[], results: Map<number, SweatResult>, limit = 10): SweatEntry[] {
  const name = (m: Member) => progressName(m.characterName, m.surname);
  return [...playerGroups(members)]
    .flatMap(([mainId, [main, ...alts]]) => {
      const r = results.get(mainId);
      return r ? [{ name: name(main), class: main.mainClass, score: r.score, tier: r.tier, alts: alts.map(name) }] : [];
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);
}
```

Note: the `results.get(2)` deepEqual-to-`results.get(1)` assertion in the alts test holds because every character in a group shares the same result object.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npx tsx --test test/sweat.test.ts test/recipe-catalog.test.ts && npm run typecheck && npm run lint`
Expected: PASS. If a hand-computed score is off by one, recheck the arithmetic in the test comment before touching the implementation — the spec is the source of truth.

- [ ] **Step 5: Commit**

```bash
git add src/sweat.ts src/recipe-catalog.ts test/sweat.test.ts test/recipe-catalog.test.ts
git commit -m "feat: compute sweat scores, tiers and the sweat leaderboard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: API — sweat on members, `altOf` checks, Sweatiest leaderboard

**Files:**
- Modify: `src/routes/members.ts`, `src/routes/progress.ts`, `src/progress-report.ts`
- Test: `test/api.test.ts`, `test/progress-api.test.ts`

**Interfaces:**
- Consumes: `computeSweat`, `sweatLeaderboard`, `SweatEntry`, `SweatResult` (Task 3); `recipeIndex` (Task 3); `altOfError` (Task 2).
- Produces: `GET /api/members` items gain `sweat: { score, tier, breakdown, mainId, main } | null`; `PUT /api/members/:id` validates `altOf`; `GET /api/progress` gains `leaderboard.sweat: SweatEntry[]`; `export function guildSweat(app: FastifyInstance, members: Member[]): Map<number, SweatResult>` in `src/routes/members.ts`; `buildProgress(snapshots, milestones, members, today, sweat: SweatEntry[] = [])`.

- [ ] **Step 1: Write the failing tests**

In `test/api.test.ts`, inside "members can be listed and their details edited…", after the `recipes` assertions add:

```ts
  // Thrall alone: top level of a guild of one, no professions; other metrics unknown.
  assert.deepEqual(list.json()[0].sweat, {
    score: 63,
    tier: "drenched",
    mainId: thrall.id,
    main: "Thrall Durotan",
    breakdown: { leveling: 62.5, gear: 0, professions: 0, dungeons: 0, pvp: 0, reputation: 0, legacy: 0, questing: 0 },
  });
```

and after the PUT: `assert.equal(updated.json().sweat.score, 63);`.

Append a new test (after "validation errors are 400…"):

```ts
test("altOf links an alt to its main and is checked against the roster", async () => {
  const thrallEntry = { name: "Thrall", surname: "Durotan", slug: "thrall-durotan", classId: "shaman", level: 14, rank: 0 };
  const [rexxar] = app.store.syncRoster([thrallEntry, { name: "Rexxar", surname: "Mok", slug: "rexxar-mok", classId: "hunter", level: 5, rank: 2 }]);
  const thrall = app.store.list().find((m) => m.characterName === "Thrall")!;
  const put = (id: number, altOf: unknown) =>
    app.inject({ method: "PUT", url: `/api/members/${id}`, cookies: cookie, payload: { ...details, altOf } });

  const linked = await put(rexxar.id, thrall.id);
  assert.equal(linked.statusCode, 200);
  assert.equal(linked.json().altOf, thrall.id);
  // Rexxar has no armory read yet, so he shows his main's score.
  assert.equal(linked.json().sweat.mainId, thrall.id);
  assert.equal(linked.json().sweat.main, "Thrall Durotan");

  const errorOf = async (id: number, altOf: unknown) => (await put(id, altOf)).json().details;
  assert.deepEqual(await errorOf(thrall.id, rexxar.id), ["altOf must point at a main, not another alt"]);
  assert.deepEqual(await errorOf(rexxar.id, rexxar.id), ["a member cannot be their own alt"]);
  assert.deepEqual(await errorOf(rexxar.id, 99999), ["altOf is not a guild member"]);
  assert.deepEqual(await errorOf(rexxar.id, "x"), ["altOf must be a member id or null"]);

  assert.equal((await put(rexxar.id, null)).json().altOf, null);
});
```

In `test/progress-api.test.ts`, in "progress reports stored history…", after the existing assertions on `body` add:

```ts
    assert.deepEqual(body.leaderboard.sweat, []); // Grom's armory hasn't been read
    const [grom] = app.store.list();
    app.store.applyArmory(grom, {
      spec: null,
      primary: [],
      secondary: [],
      armory: {
        race: null, gender: null, faction: null, title: null, itemLevel: null, lastLogin: null,
        achievementPoints: null, legacy: null, skills: {}, recipes: [], pvp: null, sweatStats: null,
      },
    });
    const sweat = (await app.inject({ method: "GET", url: "/api/progress", cookies })).json().leaderboard.sweat;
    assert.deepEqual(sweat, [{ name: "Grom Hellscream", class: "warrior", score: 63, tier: "drenched", alts: [] }]);
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npx tsx --test test/api.test.ts test/progress-api.test.ts`
Expected: FAIL — `sweat` is undefined.

- [ ] **Step 3: Implement**

`src/routes/members.ts`:

```ts
import type { FastifyInstance, FastifyPluginCallback } from "fastify";
import { BlizzardError } from "../blizzard.js";
import { altOfError, validateDetails } from "../validate.js";
import type { Member } from "../db.js";
import { audit } from "../audit.js";
import { progressName } from "../progress.js";
import { recipeIndex } from "../recipe-catalog.js";
import { computeSweat, type SweatResult } from "../sweat.js";

// Sweat scores for the whole guild (scores are relative, so always computed over every member).
export function guildSweat(app: FastifyInstance, members: Member[]): Map<number, SweatResult> {
  const catalog = app.recipes?.current() ?? null;
  return computeSweat(members, catalog ? recipeIndex(catalog) : null, Date.now());
}

// A member as the roster shows it: without recipe ids, with the player's sweat.
function present(m: Member, members: Member[], sweat: Map<number, SweatResult>) {
  const r = sweat.get(m.id);
  const main = r && members.find((x) => x.id === r.mainId);
  return {
    ...withoutRecipes(m),
    sweat: r && main ? { ...r, main: progressName(main.characterName, main.surname) } : null,
  };
}
```

(keep `withoutRecipes` and `parseId` as they are.)

GET handler body after the sync try/catch:

```ts
    const members = app.store.list();
    const sweat = guildSweat(app, members);
    return members.map((m) => present(m, members, sweat));
```

PUT handler: after the `validateDetails` check add

```ts
    const altError = altOfError(id, v.value.altOf, app.store.list());
    if (altError) return reply.code(400).send({ error: "validation failed", details: [altError] });
```

and replace `return withoutRecipes(updated);` with

```ts
    const members = app.store.list();
    return present(updated, members, guildSweat(app, members));
```

`src/progress-report.ts`:
- `import type { SweatEntry } from "./sweat.js";`
- `Leaderboard`: add `sweat: SweatEntry[];`
- `buildProgress(..., today: string, sweat: SweatEntry[] = [])` and `const leaderboard = { ...buildLeaderboard([...byName.values()], current, firsts, today), sweat };`.
- `buildLeaderboard` return type: change to `Omit<Leaderboard, "sweat">`.

`src/routes/progress.ts`:

```ts
import type { FastifyPluginCallback } from "fastify";
import { buildProgress } from "../progress-report.js";
import { utcDay } from "../progress-store.js";
import { sweatLeaderboard } from "../sweat.js";
import { guildSweat } from "./members.js";

// Level race, guild firsts and PvP history. Reads SQLite only; the guild sync fills it.
export const progressRoutes: FastifyPluginCallback = (app, _opts, done) => {
  app.get("/progress", async () => {
    const members = app.store.list();
    const sweat = sweatLeaderboard(members, guildSweat(app, members));
    return buildProgress(app.progress.snapshots(), app.progress.milestones(), members, utcDay(Date.now()), sweat);
  });
  done();
};
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npm run typecheck && npm test`
Expected: PASS (any `test/progress-report.test.ts` deepEqual on a whole leaderboard needs `sweat: []` added).

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat: serve sweat scores on the roster and a sweat leaderboard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: UI — tier pill with breakdown, Alt of, Sweatiest panel; README

**Files:**
- Modify: `public/app.js`, `public/index.html`, `public/style.css`, `public/progress.js`, `README.md`

No automated UI tests cover these renderers; verify in the browser (Step 4).

- [ ] **Step 1: Roster and form markup** (`public/index.html`)

- Roster header: replace `<th>Sweat Factor</th>` with `<th><button type="button" class="sort" data-sort="sweat">Sweat Factor</button></th>`.
- Drawer: replace `<label><span>Sweat factor</span><select id="f-sweat"></select></label>` with `<label><span>Alt of</span><select id="f-alt-of"></select></label>`.

- [ ] **Step 2: Roster logic** (`public/app.js`)

- Line 14 comment: `// { classes, professions, sweatTiers, levelingPrefs }`.
- `SORT_VALUES`: add `sweat: (m) => (m.sweat ? -m.sweat.score : null),`.
- Replace `sweatCell`:

```js
const SWEAT_LABELS = {
  leveling: "Leveling", gear: "Gear", professions: "Professions", dungeons: "Dungeons & Raids",
  pvp: "PvP", reputation: "Reputation", legacy: "Legacy", questing: "Questing",
};

// Tier pill + score; opens to the points per category. Alts show their main's sweat.
function sweatCell(m) {
  const s = m.sweat;
  if (!s) return DASH;
  const i = game.sweatTiers.findIndex((t) => t.id === s.tier);
  const parts = Object.entries(s.breakdown)
    .map(([k, v]) => `<li>${esc(SWEAT_LABELS[k] ?? k)} <span class="muted">${esc(v)}</span></li>`)
    .join("");
  const via = s.mainId !== m.id ? `<br><span class="muted sub">via ${esc(s.main)}</span>` : "";
  return `<details class="sweat"><summary><span class="pill sweat-${i}">${esc(game.sweatTiers[i]?.name ?? s.tier)}</span> <span class="muted">${esc(s.score)}</span></summary><ul>${parts}</ul></details>${via}`;
}
```

- Row: `<td data-label="Sweat Factor">${sweatCell(m)}</td>`.
- `openDrawer`: replace `$("#f-sweat").value = member.sweatFactor ?? "";` with

```js
  const mains = members.filter((x) => x.altOf === null && x.id !== member.id);
  fillSelect($("#f-alt-of"), mains.map((x) => ({ id: String(x.id), name: fullName(x) })), { placeholder: "—" });
  $("#f-alt-of").value = member.altOf == null ? "" : String(member.altOf);
```

- `formPayload`: replace the `sweatFactor` line with `altOf: $("#f-alt-of").value ? Number($("#f-alt-of").value) : null,`.
- `initForm`: delete the `fillSelect($("#f-sweat"), ...)` line.

- [ ] **Step 3: Sweatiest panel and styles**

`public/progress.js`, in the leaderboard render (around line 192), before `root.querySelector("#leaderboard").innerHTML = ...` add:

```js
  const tierPill = (id) => {
    const i = game.sweatTiers.findIndex((t) => t.id === id);
    return `<span class="pill sweat-${i}">${esc(game.sweatTiers[i]?.name ?? id)}</span>`;
  };
  const sweatiest = list(lb.sweat ?? [], "No sweat measured yet", (r) =>
    `${nameCell(r.name, r.class)} ${tierPill(r.tier)} <span class="muted">${esc(r.score)}${r.alts.length ? ` · alts: ${r.alts.map(esc).join(", ")}` : ""}</span>`,
  );
```

and insert `<section class="lb-panel lb-wide"><h3>Sweatiest</h3>${sweatiest}</section>` between the "Most guild firsts" and "Profession skill" panels.

`public/style.css`, after `.sweat-4`:

```css
.sweat-5 { color: #fff; border-color: #ff3c8a; background: linear-gradient(90deg, #b3122a, #ff3c8a); box-shadow: 0 0 10px rgba(255, 60, 138, 0.6); }
details.sweat summary { cursor: pointer; list-style: none; white-space: nowrap; }
details.sweat summary::-webkit-details-marker { display: none; }
details.sweat ul { margin: 4px 0 0; padding-left: 16px; font-size: 12px; }
```

`README.md`:
- Intro: "Members add a backup class/spec, sweat factor, leveling preference and notes" → "Members add a backup class/spec, leveling preference, notes and which character is their main; a sweat factor is computed from armory data (see `docs/superpowers/specs/2026-11-06-sweat-factor-design.md`)".
- game-data row: "sweat factors" → "sweat tiers".
- PUT row: `sweatFactor` → `altOf` (member id of their main, or null).
- GET members row: append "; each member has `sweat` (`score`, `tier`, `breakdown`, `mainId`, `main`) or null".

- [ ] **Step 4: Verify in the browser**

Use the `run` skill (or `set -a; source .env; set +a; npm run dev`) and open http://localhost:3000:
- Roster: Sweat Factor shows tier pills with scores; clicking one lists the categories; header sorts by score; a member with no armory shows "—".
- Edit a member: "Alt of" lists mains only (not self); saving links them and their row shows "via <Main>"; an invalid choice (via API) is rejected.
- Progress tab: "Sweatiest" panel lists players with tier pills and alts.
- Check mobile width (≤ 600px) that the roster card shows the pill without overflow.

- [ ] **Step 5: Commit**

```bash
git add public README.md
git commit -m "feat: show computed sweat tiers, alt links and the Sweatiest leaderboard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Simplify and verify

- [ ] **Step 1:** Run the code-simplifier agent on every file modified in Tasks 1–5 (user CLAUDE.md requirement). Apply its changes only if tests stay green.
- [ ] **Step 2:** Run `npm run lint && npm run typecheck && npm test`. Expected: all pass. Paste the summary line of `npm test` into the PR description.
- [ ] **Step 3:** `grep -rn "sweatFactor\|SWEAT_FACTORS\|f-sweat" src public test` — expected: no matches (only the `sweat_factor` column in `src/db.ts`).
- [ ] **Step 4:** Commit any simplifier changes:

```bash
git add -A src public test
git commit -m "refactor: simplify sweat factor code

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
