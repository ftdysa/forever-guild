# Crafting Directory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Crafting tab that shows who in Old School can craft each recipe, which recipes nobody knows yet, and every recipe's reagents, searchable by recipe, item or reagent.

**Architecture:** A server-side `RecipeCatalog` prefetches the Forever recipe catalog (≈2,500 recipes with reagents) from Blizzard's static API into the existing `armory_cache` table, rebuilding when the game build changes or on demand via a CLI. The guild sync already reads each member's professions; it now also stores their known recipe ids. `GET /api/crafting` joins the catalog to members, and the browser filters it locally.

**Tech Stack:** TypeScript (Node ≥ 20, ESM), Fastify 5, better-sqlite3, `node:test` via `tsx`, vanilla JS frontend modules, `@fastify/compress`.

**Spec:** `docs/superpowers/specs/2026-11-05-crafting-directory-design.md`

## Global Constraints

- Professions included (our ids): `alchemy`, `blacksmithing`, `enchanting`, `engineering`, `leatherworking`, `tailoring`, `cooking`, `first-aid`, `mining`. Herbalism, Skinning, Fishing and Blizzard's "Test Profession [DNT]" are excluded.
- Forever only: the catalog exists only when `config.blizzard.namespace === "forever"`; otherwise `/api/crafting` answers 404 and the tab stays hidden.
- Static calls run at most 8 at a time (`mapLimit(…, 8, …)` from `src/concurrency.ts`).
- Catalog cache key: `<region>:forever:recipes:v1` in `armory_cache`.
- A failed build never overwrites the stored catalog. A recipe whose details 404 is kept with its name, `itemId: null`, `itemName: null`, `makes: 1`, no reagents; any other error fails the build.
- Results in the UI are capped at 200 rows.
- All Blizzard- or user-supplied text is escaped with `esc()` or set via `textContent`; colours/widths go through the DOM, never `style=""` (CSP has no `'unsafe-inline'`).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Checks before each commit: `npm test`, `npm run typecheck`, `npm run lint` all clean.

## File Structure

| File | Responsibility |
|---|---|
| `src/armory.ts` (modify) | `mapProfessions` also returns known recipe ids; character cache key bumped |
| `src/db.ts` (modify) | `MemberArmory.recipes`; `ArmoryCache.fetchedAt()` |
| `src/guild-sync.ts` (modify) | snapshot stores `recipes` |
| `src/recipe-catalog.ts` (create) | build/cache/single-flight/build-check of the recipe catalog; `craftersByRecipe` join |
| `src/routes/crafting.ts` (create) | `GET /api/crafting` |
| `src/app.ts` (modify) | create catalog, startup check, daily timer, compression, route |
| `src/refresh-recipes.ts` (create) | CLI to force a rebuild |
| `public/crafting.js` (create) | pure `filterCatalog`, `coverage`; `renderCrafting` |
| `public/index.html`, `public/app.js`, `public/style.css` (modify) | tab, wiring, styles |
| `README.md`, `package.json` (modify) | docs, script, dependency |

---

### Task 1: Store each member's known recipe ids

**Files:**
- Modify: `src/armory.ts` (interface `Professions`, `RawProfession`, `mapProfessions`, character cache key)
- Modify: `src/db.ts` (`MemberArmory`)
- Modify: `src/guild-sync.ts` (`snapshot`)
- Test: `test/armory.test.ts`, `test/guild-sync.test.ts`, `test/db.test.ts`

**Interfaces:**
- Produces: `Professions.recipes: number[]` (known recipe ids across all of the character's professions); `MemberArmory.recipes: number[]`.

- [ ] **Step 1: Write the failing tests**

In `test/armory.test.ts`, replace the body of the test `"mapProfessions maps known names and drops the rest"` with:

```ts
test("mapProfessions maps known names and drops the rest", () => {
  const raw = {
    primaries: [
      {
        profession: { name: "Herbalism" },
        tiers: [{ skill_points: 120, max_skill_points: 150, known_recipes: [{ id: 2366 }] }],
      },
      { profession: { name: "Inscription" }, tiers: [{ known_recipes: [{ id: 999 }] }] },
      { profession: { name: "Alchemy" }, tiers: [{ known_recipes: [{ id: 2329 }, { id: 2330 }] }] },
    ],
    secondaries: [{ profession: { name: "Cooking" } }, { profession: { name: "Archaeology" } }],
  };
  assert.deepEqual(mapProfessions(raw), {
    primary: ["herbalism", "alchemy"],
    secondary: ["cooking"],
    skills: { herbalism: { skill: 120, max: 150 } },
    // professions we don't track (Inscription) contribute no recipes
    recipes: [2366, 2329, 2330],
  });
  assert.equal(mapProfessions(null), null);
});
```

In the same file, update the two expectations that compare whole `professions` objects:

```ts
assert.deepEqual((await armory.character("jaina"))?.professions, { primary: ["tailoring"], secondary: [], skills: {}, recipes: [] });
```

```ts
assert.deepEqual(c?.professions, { primary: ["tailoring"], secondary: [], skills: {}, recipes: [] });
```

In `test/guild-sync.test.ts`, inside `routes()`, give Thrall's alchemy known recipes:

```ts
    [`${char("thrall-durotan")}/professions`]: {
      primaries: [
        { profession: { name: "Alchemy" }, tiers: [{ skill_points: 60, max_skill_points: 75, known_recipes: [{ id: 2329 }] }] },
        { profession: { name: "Herbalism" } },
      ],
      secondaries: [{ profession: { name: "Cooking" } }],
    },
```

and in the test `"the first sync seeds the roster silently and fills spec and professions from the armory"` replace the two armory assertions with:

```ts
  // the armory snapshot is stored for the roster's extra columns and the crafting directory
  assert.equal(thrall.armory?.lastLogin, null);
  assert.deepEqual(thrall.armory?.skills, { alchemy: { skill: 60, max: 75 } });
  assert.deepEqual(thrall.armory?.recipes, [2329]);
```

In `test/db.test.ts`, add `recipes: []` to the `ARMORY` constant:

```ts
const ARMORY = { race: "Human", gender: "Female", faction: "alliance" as const, title: null, itemLevel: 12, lastLogin: null, achievementPoints: 0, legacy: { earned: 1, total: 65 }, skills: {}, recipes: [] };
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | grep -E "^not ok|^# (pass|fail)"`
Expected: FAIL on `mapProfessions maps known names…`, the two professions expectations, and the guild-sync seeding test (`recipes` missing).

- [ ] **Step 3: Implement**

In `src/armory.ts`:

```ts
export interface Professions {
  primary: string[];
  secondary: string[];
  // Current and maximum skill by profession id.
  skills: Record<string, { skill: number; max: number }>;
  // Known recipe ids across the professions above (crafting directory).
  recipes: number[];
}
```

```ts
type RawProfession = {
  profession: { name: string };
  tiers?: { skill_points?: number; max_skill_points?: number; known_recipes?: { id: number }[] }[];
};
```

Replace `mapProfessions` with:

```ts
export function mapProfessions(raw: RawProfessions | null): CharacterInfo["professions"] {
  if (!raw) return null;
  const skills: Professions["skills"] = {};
  const recipes: number[] = [];
  const pick = (list: RawProfession[] | undefined, kind: "primary" | "secondary") =>
    (list ?? []).flatMap((p) => {
      const id = PROFESSIONS.find((x) => x.kind === kind && x.name.toLowerCase() === p.profession.name.toLowerCase())?.id;
      if (!id) return [];
      // Classic-style professions have a single tier.
      const tier = p.tiers?.[0];
      if (tier?.skill_points !== undefined) skills[id] = { skill: tier.skill_points, max: tier.max_skill_points ?? tier.skill_points };
      for (const r of tier?.known_recipes ?? []) recipes.push(r.id);
      return [id];
    });
  return { primary: pick(raw.primaries, "primary").slice(0, 2), secondary: pick(raw.secondaries, "secondary"), skills, recipes };
}
```

Bump the character cache key (cached entries from older deploys lack `recipes`; the cache outlives deploys):

```ts
    const key = `${this.keyPrefix}:character:v6:${base}`;
```

In `src/db.ts`, add to `MemberArmory` after `skills`:

```ts
  // Known recipe ids (crafting directory).
  recipes: number[];
```

In `src/guild-sync.ts`, in `snapshot()` after `skills`:

```ts
    recipes: c.professions?.recipes ?? [],
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test 2>&1 | grep -E "^not ok|^# (pass|fail)"; npm run typecheck; npm run lint`
Expected: `# fail 0`, no typecheck or lint output.

- [ ] **Step 5: Commit**

```bash
git add src/armory.ts src/db.ts src/guild-sync.ts test/armory.test.ts test/guild-sync.test.ts test/db.test.ts
git commit -m "feat: store each member's known recipe ids

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Recipe catalog builder

**Files:**
- Create: `src/recipe-catalog.ts`
- Modify: `src/db.ts` (add `ArmoryCache.fetchedAt`)
- Test: `test/recipe-catalog.test.ts`

**Interfaces:**
- Consumes: `BlizzardClient.gameData<T>(path, params?)` (resolves `null` on 404, throws `BlizzardError` otherwise); `ArmoryCache.get/set`; `mapLimit` from `src/concurrency.ts`; `PROFESSIONS` from `src/game-data.ts`; `Member` from `src/db.ts`.
- Produces:
  - `interface CatalogRecipe { id: number; name: string; itemId: number | null; itemName: string | null; makes: number; reagents: { itemId: number; name: string; quantity: number }[] }`
  - `interface Catalog { build: string; builtAt: string; professions: { id: string; name: string; total: number; categories: { name: string; recipes: CatalogRecipe[] }[] }[] }`
  - `interface Crafter { memberId: number; characterName: string; surname: string | null; skill: number | null }`
  - `function buildOf(href: string | undefined): string | null`
  - `function craftersByRecipe(catalog: Catalog, members: Member[]): Record<number, Crafter[]>`
  - `class RecipeCatalog { constructor(client, cache, region: string, now?: () => number); current(): Catalog | null; isBuilding(): boolean; hasFailed(): boolean; rebuild(): Promise<Catalog>; checkBuild(): Promise<boolean>; idle(): Promise<void> }`
  - `ArmoryCache.fetchedAt(key: string): number | undefined`

- [ ] **Step 1: Write the failing tests**

Create `test/recipe-catalog.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { BlizzardClient } from "../src/blizzard.js";
import { ArmoryCache, openDatabase, type Member } from "../src/db.js";
import { buildOf, craftersByRecipe, RecipeCatalog, type Catalog } from "../src/recipe-catalog.js";
import { fakeBlizzard } from "./fake-blizzard.js";

const self = (build: string) => ({ self: { href: `https://us.api.blizzard.com/data/wow/profession/?namespace=static-${build}-forever-us` } });

// Engineering (2 recipes, one 404s), Herbalism (excluded), a test profession (excluded).
function routes(build = "1.60.1_70399") {
  return {
    "/data/wow/profession/index": {
      _links: self(build),
      professions: [
        { id: 202, name: "Engineering" },
        { id: 182, name: "Herbalism" },
        { id: 2933, name: "Test Profession [DNT]" },
      ],
    },
    "/data/wow/profession/202": { skill_tiers: [{ id: 2941 }] },
    "/data/wow/profession/202/skill-tier/2941": {
      categories: [
        { name: "Explosives", recipes: [{ id: 2414, name: "Rough Dynamite" }, { id: 9999, name: "Lost Recipe" }] },
      ],
    },
    "/data/wow/recipe/2414": {
      crafted_item: { id: 4358, name: "Rough Dynamite" },
      reagents: [
        { reagent: { id: 4357, name: "Rough Blasting Powder" }, quantity: 1 },
        { reagent: { id: 2589, name: "Linen Cloth" }, quantity: 1 },
      ],
      crafted_quantity: { value: 2.0 },
    },
    // 9999: no route → 404, kept by name
  } as Record<string, unknown>;
}

function setup(r = routes()) {
  let t = 1_000_000;
  const fake = fakeBlizzard(r);
  const db = openDatabase(":memory:");
  const cache = new ArmoryCache(db);
  const client = new BlizzardClient({ clientId: "id", clientSecret: "s", region: "us", namespace: "forever" }, fake.fetchFn);
  const catalog = new RecipeCatalog(client, cache, "us", () => (t += 1));
  return { fake, cache, client, catalog, db };
}

test("buildOf reads the game build from a static self link", () => {
  assert.equal(buildOf("https://us.api.blizzard.com/x?namespace=static-1.60.1_70399-forever-us"), "1.60.1_70399");
  assert.equal(buildOf("https://us.api.blizzard.com/x?namespace=static-1.15.9_68185-classic1x-us"), null);
  assert.equal(buildOf(undefined), null);
});

test("builds included professions with recipes, reagents and crafted counts", async () => {
  const { catalog, fake } = setup();
  const c = await catalog.rebuild();
  assert.equal(c.build, "1.60.1_70399");
  assert.deepEqual(c.professions.map((p) => [p.id, p.name, p.total]), [["engineering", "Engineering", 2]]);
  assert.deepEqual(c.professions[0].categories[0], {
    name: "Explosives",
    recipes: [
      {
        id: 2414,
        name: "Rough Dynamite",
        itemId: 4358,
        itemName: "Rough Dynamite",
        makes: 2,
        reagents: [
          { itemId: 4357, name: "Rough Blasting Powder", quantity: 1 },
          { itemId: 2589, name: "Linen Cloth", quantity: 1 },
        ],
      },
      { id: 9999, name: "Lost Recipe", itemId: null, itemName: null, makes: 1, reagents: [] },
    ],
  });
  // excluded professions are never fetched
  assert.ok(!fake.calls.some((p) => p.startsWith("/data/wow/profession/182") || p.startsWith("/data/wow/profession/2933")));
  assert.deepEqual(catalog.current(), c);
});

test("concurrent rebuilds share one build", async () => {
  const { catalog, fake } = setup();
  await Promise.all([catalog.rebuild(), catalog.rebuild(), catalog.checkBuild()]);
  assert.equal(fake.calls.filter((p) => p === "/data/wow/recipe/2414").length, 1);
});

test("a failed rebuild keeps the previous catalog", async () => {
  const { catalog, fake } = setup();
  const first = await catalog.rebuild();
  fake.state.apiDown = true;
  await assert.rejects(catalog.rebuild(), /unreachable/);
  assert.deepEqual(catalog.current(), first);
  assert.equal(catalog.hasFailed(), true);
});

test("a first build that fails leaves no catalog and reports failure", async () => {
  const { catalog, fake } = setup();
  fake.state.apiDown = true;
  await assert.rejects(catalog.rebuild());
  assert.equal(catalog.current(), null);
  assert.equal(catalog.hasFailed(), true);
  assert.equal(catalog.isBuilding(), false);
});

test("checkBuild builds when empty, skips an unchanged build, rebuilds a new one", async () => {
  const r = routes();
  const { catalog, fake } = setup(r);
  assert.equal(await catalog.checkBuild(), true);
  assert.equal(await catalog.checkBuild(), false);
  assert.equal(fake.calls.filter((p) => p === "/data/wow/recipe/2414").length, 1);
  (r["/data/wow/profession/index"] as { _links: unknown })._links = self("1.61.0_71000");
  assert.equal(await catalog.checkBuild(), true);
  assert.equal(catalog.current()?.build, "1.61.0_71000");
});

test("a catalog written by another process is picked up", async () => {
  const { catalog, cache } = setup();
  await catalog.rebuild();
  const other: Catalog = { build: "x", builtAt: "y", professions: [] };
  cache.set("us:forever:recipes:v1", other, 9_999_999);
  assert.deepEqual(catalog.current(), other);
});

test("craftersByRecipe joins members by known recipe, best skill first", () => {
  const catalog: Catalog = {
    build: "b",
    builtAt: "t",
    professions: [
      { id: "engineering", name: "Engineering", total: 1, categories: [{ name: "Explosives", recipes: [{ id: 2414, name: "Rough Dynamite", itemId: 4358, itemName: "Rough Dynamite", makes: 2, reagents: [] }] }] },
    ],
  };
  const member = (id: number, name: string, skill: number | null, recipes: number[]) =>
    ({
      id,
      characterName: name,
      surname: "Deez",
      armory: { recipes, skills: skill === null ? {} : { engineering: { skill, max: 150 } } },
    }) as unknown as Member;
  const out = craftersByRecipe(catalog, [
    member(1, "Low", 40, [2414]),
    member(2, "High", 69, [2414]),
    member(3, "Unknown", null, [2414]),
    member(4, "Nope", 100, []),
    { id: 5, characterName: "NoArmory", surname: null, armory: null } as unknown as Member,
  ]);
  assert.deepEqual(out, {
    2414: [
      { memberId: 2, characterName: "High", surname: "Deez", skill: 69 },
      { memberId: 1, characterName: "Low", surname: "Deez", skill: 40 },
      { memberId: 3, characterName: "Unknown", surname: "Deez", skill: null },
    ],
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test test/recipe-catalog.test.ts 2>&1 | tail -5`
Expected: FAIL — `Cannot find module '../src/recipe-catalog.js'`.

- [ ] **Step 3: Implement**

In `src/db.ts`, inside `class ArmoryCache`, add a prepared statement and method (cheap freshness check without parsing the body):

```ts
  private findTime: Database.Statement;
```

in the constructor after `this.find = …`:

```ts
    this.findTime = db.prepare("SELECT fetched_at FROM armory_cache WHERE key = ?");
```

and the method:

```ts
  // The entry's write time without parsing its body (cheap check for large entries).
  fetchedAt(key: string): number | undefined {
    const row = this.findTime.get(key) as { fetched_at: number } | undefined;
    return row?.fetched_at;
  }
```

Create `src/recipe-catalog.ts`:

```ts
import type { BlizzardClient } from "./blizzard.js";
import { BlizzardError } from "./blizzard.js";
import { mapLimit } from "./concurrency.js";
import type { ArmoryCache, Member } from "./db.js";
import { PROFESSIONS } from "./game-data.js";

// Professions in the crafting directory (our ids). Herbalism, Skinning and Fishing are left out:
// their "recipes" are abilities, not items. Mining stays for smelting.
const INCLUDED = [
  "alchemy", "blacksmithing", "enchanting", "engineering", "leatherworking", "tailoring", "cooking", "first-aid", "mining",
];
// Static lookups in flight at once.
const CONCURRENCY = 8;

export interface CatalogRecipe {
  id: number;
  name: string;
  // Crafted item; null for recipes that make none (enchants) or whose details 404'd.
  itemId: number | null;
  itemName: string | null;
  makes: number;
  reagents: { itemId: number; name: string; quantity: number }[];
}

export interface Catalog {
  // Blizzard game build the catalog was read from, e.g. "1.60.1_70399".
  build: string;
  builtAt: string;
  professions: { id: string; name: string; total: number; categories: { name: string; recipes: CatalogRecipe[] }[] }[];
}

export interface Crafter {
  memberId: number;
  characterName: string;
  surname: string | null;
  skill: number | null;
}

interface RawIndex {
  _links?: { self?: { href?: string } };
  professions?: { id: number; name: string }[];
}
interface RawProfession {
  skill_tiers?: { id: number }[];
}
interface RawSkillTier {
  categories?: { name: string; recipes?: { id: number; name: string }[] }[];
}
interface RawRecipe {
  crafted_item?: { id: number; name?: string };
  reagents?: { reagent: { id: number; name: string }; quantity: number }[];
  crafted_quantity?: { value?: number };
}

// "…?namespace=static-1.60.1_70399-forever-us" → "1.60.1_70399"; null for other flavours.
export function buildOf(href: string | undefined): string | null {
  if (!href) return null;
  const ns = new URL(href).searchParams.get("namespace");
  return ns?.match(/^static-(.+)-forever-[a-z]+$/)?.[1] ?? null;
}

function toRecipe(r: { id: number; name: string }, raw: RawRecipe | null): CatalogRecipe {
  return {
    id: r.id,
    name: r.name,
    itemId: raw?.crafted_item?.id ?? null,
    itemName: raw?.crafted_item?.name ?? null,
    makes: Math.max(1, Math.round(raw?.crafted_quantity?.value ?? 1)),
    reagents: (raw?.reagents ?? []).map((x) => ({ itemId: x.reagent.id, name: x.reagent.name, quantity: x.quantity })),
  };
}

// Recipe id → members who know it, best skill first (unknown skill last), then by name.
export function craftersByRecipe(catalog: Catalog, members: Member[]): Record<number, Crafter[]> {
  const professionOf = new Map<number, string>();
  for (const p of catalog.professions) for (const c of p.categories) for (const r of c.recipes) professionOf.set(r.id, p.id);
  const out: Record<number, Crafter[]> = {};
  for (const m of members) {
    for (const id of m.armory?.recipes ?? []) {
      const prof = professionOf.get(id);
      if (!prof) continue;
      (out[id] ??= []).push({
        memberId: m.id,
        characterName: m.characterName,
        surname: m.surname,
        skill: m.armory?.skills[prof]?.skill ?? null,
      });
    }
  }
  for (const list of Object.values(out)) {
    list.sort((a, b) => (b.skill ?? -1) - (a.skill ?? -1) || a.characterName.localeCompare(b.characterName));
  }
  return out;
}

// The Forever recipe catalog, prefetched from static data into the armory cache.
//
// A build reads every included profession's recipes and each recipe's details (≈2,500 calls,
// 8 at a time). It is written only when complete, so a failed rebuild keeps serving the old
// catalog. Concurrent rebuilds share one run.
export class RecipeCatalog {
  private key: string;
  private memo: { fetchedAt: number; catalog: Catalog } | null = null;
  private building: Promise<Catalog> | null = null;
  private failed = false;

  constructor(
    private client: BlizzardClient,
    private cache: ArmoryCache,
    region: string,
    private now: () => number = Date.now,
  ) {
    this.key = `${region}:forever:recipes:v1`;
  }

  // The stored catalog, parsed once per write (another process, e.g. the CLI, may rewrite it).
  current(): Catalog | null {
    const fetchedAt = this.cache.fetchedAt(this.key);
    if (fetchedAt === undefined) return null;
    if (this.memo?.fetchedAt !== fetchedAt) {
      this.memo = { fetchedAt, catalog: this.cache.get(this.key)!.value as Catalog };
    }
    return this.memo.catalog;
  }

  isBuilding(): boolean {
    return this.building !== null;
  }

  // True when the most recent build failed.
  hasFailed(): boolean {
    return this.failed;
  }

  rebuild(): Promise<Catalog> {
    this.building ??= this.build()
      .then((catalog) => {
        this.cache.set(this.key, catalog, this.now());
        this.failed = false;
        return catalog;
      })
      .catch((err: unknown) => {
        this.failed = true;
        throw err;
      })
      .finally(() => {
        this.building = null;
      });
    return this.building;
  }

  // One call: rebuilds when nothing is stored or Blizzard's game build changed. Resolves true
  // when it rebuilt.
  async checkBuild(): Promise<boolean> {
    if (this.building) {
      await this.building;
      return true;
    }
    // Nothing stored: build straight away, so a failure is recorded (hasFailed) even when the
    // very first index call fails.
    const stored = this.current();
    if (stored) {
      const index = await this.client.gameData<RawIndex>("/data/wow/profession/index");
      const build = buildOf(index?._links?.self?.href);
      if (build !== null && stored.build === build) return false;
    }
    await this.rebuild();
    return true;
  }

  // Waits for an in-flight build (shutdown, tests). Never rejects.
  async idle(): Promise<void> {
    await this.building?.catch(() => undefined);
  }

  private async build(): Promise<Catalog> {
    const index = await this.client.gameData<RawIndex>("/data/wow/profession/index");
    if (!index) throw new BlizzardError("profession index not found");
    const wanted = (index.professions ?? []).flatMap((p) => {
      const ours = PROFESSIONS.find((x) => x.name.toLowerCase() === p.name.toLowerCase());
      return ours && INCLUDED.includes(ours.id) ? [{ blizzardId: p.id, id: ours.id, name: ours.name }] : [];
    });
    const professions: Catalog["professions"] = [];
    for (const p of wanted) {
      const prof = await this.client.gameData<RawProfession>(`/data/wow/profession/${p.blizzardId}`);
      const tierId = prof?.skill_tiers?.[0]?.id;
      const tier =
        tierId === undefined ? null : await this.client.gameData<RawSkillTier>(`/data/wow/profession/${p.blizzardId}/skill-tier/${tierId}`);
      const categories = tier?.categories ?? [];
      const ids = categories.flatMap((c) => (c.recipes ?? []).map((r) => r.id));
      const details = new Map(
        await mapLimit(ids, CONCURRENCY, async (id) => [id, await this.client.gameData<RawRecipe>(`/data/wow/recipe/${id}`)] as const),
      );
      professions.push({
        id: p.id,
        name: p.name,
        total: ids.length,
        categories: categories.map((c) => ({
          name: c.name,
          recipes: (c.recipes ?? []).map((r) => toRecipe(r, details.get(r.id) ?? null)),
        })),
      });
    }
    return { build: buildOf(index._links?.self?.href) ?? "unknown", builtAt: new Date(this.now()).toISOString(), professions };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test test/recipe-catalog.test.ts 2>&1 | grep -E "^not ok|^# (pass|fail)"; npm test 2>&1 | grep -E "^# (pass|fail)"; npm run typecheck; npm run lint`
Expected: `# fail 0` for both runs; no typecheck or lint output.

- [ ] **Step 5: Commit**

```bash
git add src/recipe-catalog.ts src/db.ts test/recipe-catalog.test.ts
git commit -m "feat: recipe catalog prefetched from Forever static data

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `/api/crafting`, startup build, daily build check, compression

**Files:**
- Create: `src/routes/crafting.ts`
- Modify: `src/app.ts`
- Modify: `package.json`, `package-lock.json` (add `@fastify/compress`)
- Test: `test/crafting-api.test.ts`

**Interfaces:**
- Consumes: `RecipeCatalog` (`current`, `isBuilding`, `checkBuild`, `idle`), `craftersByRecipe` from Task 2; `app.store.list()`.
- Produces: `app.recipes: RecipeCatalog | null`; `AppDeps.recipeCheckEveryMs?: number` (0 disables the daily timer); `GET /api/crafting` → `{ status: "ready" | "building" | "unavailable"; catalog: Catalog | null; crafters: Record<number, Crafter[]> }`.

- [ ] **Step 1: Install the dependency**

Run: `npm install @fastify/compress@^8`
Expected: `package.json` gains `"@fastify/compress": "^8.x.x"` under dependencies.

- [ ] **Step 2: Write the failing tests**

Create `test/crafting-api.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { sessionCookieName } from "../src/routes/auth.js";
import { fakeBlizzard } from "./fake-blizzard.js";

const PASS = "for-the-horde-forever";
const base = { port: 0, dbPath: ":memory:", guildPassphrase: PASS, sessionSecret: "x".repeat(40), cookieSecure: false };
const forever = { clientId: "id", clientSecret: "s", region: "us", namespace: "forever", guild: "old-school", ranks: [] };

const routes = () =>
  ({
    "/data/wow/profession/index": {
      _links: { self: { href: "https://us.api.blizzard.com/x?namespace=static-1.60.1_70399-forever-us" } },
      professions: [{ id: 202, name: "Engineering" }],
    },
    "/data/wow/profession/202": { skill_tiers: [{ id: 2941 }] },
    "/data/wow/profession/202/skill-tier/2941": { categories: [{ name: "Explosives", recipes: [{ id: 2414, name: "Rough Dynamite" }] }] },
    "/data/wow/recipe/2414": { crafted_item: { id: 4358, name: "Rough Dynamite" }, reagents: [], crafted_quantity: { value: 2 } },
  }) as Record<string, unknown>;

async function login(a: FastifyInstance) {
  const res = await a.inject({ method: "POST", url: "/api/login", payload: { passphrase: PASS } });
  const name = sessionCookieName(false);
  return { [name]: res.cookies.find((c) => c.name === name)!.value };
}

async function start(blizzard: object | undefined, r = routes()) {
  const fake = fakeBlizzard(r);
  const app = buildApp({ ...base, ...(blizzard ? { blizzard } : {}) } as never, {
    blizzardFetch: fake.fetchFn,
    syncEveryMs: 0,
    recipeCheckEveryMs: 0,
  });
  await app.ready();
  return { app, fake, cookies: await login(app) };
}

test("crafting requires a session", async () => {
  const { app } = await start(forever);
  try {
    assert.equal((await app.inject({ method: "GET", url: "/api/crafting" })).statusCode, 401);
  } finally {
    await app.close();
  }
});

test("404 without the armory or outside Forever", async () => {
  for (const blizzard of [undefined, { ...forever, namespace: "classic1x", realm: "doomhowl" }]) {
    const { app, cookies } = await start(blizzard);
    try {
      assert.equal(app.recipes, null);
      assert.equal((await app.inject({ method: "GET", url: "/api/crafting", cookies })).statusCode, 404);
    } finally {
      await app.close();
    }
  }
});

test("startup builds the catalog; the route joins crafters", async () => {
  const { app, cookies } = await start(forever);
  try {
    await app.recipes!.idle();
    const [m] = app.store.syncRoster([
      { name: "Darrell", surname: "Deez", slug: "darrell-deez", classId: "rogue", level: 19, rank: 3 },
    ]);
    app.store.applyArmory(m, {
      spec: null,
      primary: ["engineering"],
      secondary: [],
      armory: {
        race: null, gender: null, faction: null, title: null, itemLevel: null, lastLogin: null,
        achievementPoints: null, legacy: null, skills: { engineering: { skill: 69, max: 150 } }, recipes: [2414],
      },
    });
    const res = await app.inject({ method: "GET", url: "/api/crafting", cookies });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.status, "ready");
    assert.equal(body.catalog.build, "1.60.1_70399");
    assert.deepEqual(body.crafters, { 2414: [{ memberId: m.id, characterName: "Darrell", surname: "Deez", skill: 69 }] });
  } finally {
    await app.close();
  }
});

test("building, then unavailable when the first build fails", async () => {
  const fake = fakeBlizzard(routes());
  fake.state.apiDown = true;
  const app = buildApp({ ...base, blizzard: forever } as never, { blizzardFetch: fake.fetchFn, syncEveryMs: 0, recipeCheckEveryMs: 0 });
  await app.ready();
  try {
    const cookies = await login(app);
    await app.recipes!.idle();
    const res = await app.inject({ method: "GET", url: "/api/crafting", cookies });
    assert.deepEqual(res.json(), { status: "unavailable", catalog: null, crafters: {} });
  } finally {
    await app.close();
  }
});

test("large responses are compressed", async () => {
  const { app, cookies } = await start(forever);
  try {
    await app.recipes!.idle();
    const res = await app.inject({ method: "GET", url: "/app.js", headers: { "accept-encoding": "gzip" }, cookies });
    assert.equal(res.headers["content-encoding"], "gzip");
  } finally {
    await app.close();
  }
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx tsx --test test/crafting-api.test.ts 2>&1 | grep -E "^not ok|^# (pass|fail)"`
Expected: FAIL (`app.recipes` undefined, `/api/crafting` 404).

- [ ] **Step 4: Implement**

Create `src/routes/crafting.ts`:

```ts
import type { FastifyPluginCallback } from "fastify";
import { craftersByRecipe } from "../recipe-catalog.js";

// The crafting directory: the recipe catalog joined to the members who know each recipe.
export const craftingRoutes: FastifyPluginCallback = (app, _opts, done) => {
  app.get("/crafting", async (_req, reply) => {
    if (!app.recipes) return reply.code(404).send({ error: "crafting disabled" });
    const catalog = app.recipes.current();
    if (!catalog) {
      const status = app.recipes.isBuilding() || !app.recipes.hasFailed() ? "building" : "unavailable";
      return { status, catalog: null, crafters: {} };
    }
    return { status: "ready", catalog, crafters: craftersByRecipe(catalog, app.store.list()) };
  });
  done();
};
```

In `src/app.ts`:

Imports:

```ts
import fastifyCompress from "@fastify/compress";
import { RecipeCatalog } from "./recipe-catalog.js";
import { craftingRoutes } from "./routes/crafting.js";
```

In `declare module "fastify"` → `interface FastifyInstance`, after `guildSync`:

```ts
    recipes: RecipeCatalog | null;
```

In `AppDeps`, after `syncEveryMs`:

```ts
  // Daily recipe-catalog build check interval; 0 disables the timer (tests).
  recipeCheckEveryMs?: number;
```

Next to the other constants at the top:

```ts
const RECIPE_CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
```

Where `armory` is created, keep the `BlizzardClient` in a variable so the catalog shares it (and its token):

```ts
  const bz = config.blizzard;
  const client = bz ? new BlizzardClient(bz, deps.blizzardFetch) : null;
  const armory = bz && client ? new ArmoryService(client, new ArmoryCache(db), bz) : null;
```

After `app.decorate("guildSync", guildSync);`:

```ts
  // The crafting directory exists only on Forever (its static data has the recipe catalog we read).
  const recipes = bz?.namespace === "forever" && client ? new RecipeCatalog(client, new ArmoryCache(db), bz.region) : null;
  app.decorate("recipes", recipes);
```

Replace the timer/onClose block with:

```ts
  // Page loads sync too; the timer catches joins and level-ups while nobody is looking. It runs as
  // often as the roster cache expires, so each tick can see a fresh roster.
  let syncTimer: NodeJS.Timeout | undefined;
  if (guildSync && deps.syncEveryMs !== 0) {
    syncTimer = setInterval(() => {
      guildSync.sync().catch((err: unknown) => app.log.warn({ err }, "scheduled guild sync failed"));
    }, deps.syncEveryMs ?? ROSTER_TTL_MS);
    syncTimer.unref();
  }
  // The recipe catalog is checked at startup (built if missing) and daily for a new game build.
  const checkRecipes = () => {
    recipes?.checkBuild().catch((err: unknown) => app.log.warn({ err }, "recipe catalog build failed"));
  };
  let recipeTimer: NodeJS.Timeout | undefined;
  if (recipes) {
    app.addHook("onReady", async () => checkRecipes());
    if (deps.recipeCheckEveryMs !== 0) {
      recipeTimer = setInterval(checkRecipes, deps.recipeCheckEveryMs ?? RECIPE_CHECK_EVERY_MS);
      recipeTimer.unref();
    }
  }
  app.addHook("onClose", async () => {
    clearInterval(syncTimer);
    clearInterval(recipeTimer);
    await guildSync?.idle();
    await recipes?.idle();
    db.close();
  });
```

Register compression before the static plugin (after `fastifyHelmet`):

```ts
  // The recipe catalog is ~400 KB of JSON; compression brings it to ~60 KB.
  app.register(fastifyCompress, { global: true, threshold: 1024 });
```

Register the route next to the others:

```ts
        secured.register(craftingRoutes);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test 2>&1 | grep -E "^not ok|^# (pass|fail)"; npm run typecheck; npm run lint`
Expected: `# fail 0`; no typecheck or lint output. (Other Forever app tests now also attempt a startup catalog build against fixtures without a profession index; that fails quietly as `unavailable` and must not break them.)

- [ ] **Step 6: Commit**

```bash
git add src/routes/crafting.ts src/app.ts package.json package-lock.json test/crafting-api.test.ts
git commit -m "feat: /api/crafting with startup build and daily build check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `npm run refresh-recipes`

**Files:**
- Create: `src/refresh-recipes.ts`
- Modify: `package.json` (script), `README.md`
- Test: manual run (Step 3) — the CLI is a thin wrapper over `RecipeCatalog.rebuild()`, which Task 2 tests.

**Interfaces:**
- Consumes: `loadConfig` from `src/config.ts`; `BlizzardClient`; `ArmoryCache`, `openDatabase`; `RecipeCatalog`.

- [ ] **Step 1: Implement the CLI**

Create `src/refresh-recipes.ts`:

```ts
import { BlizzardClient } from "./blizzard.js";
import { loadConfig } from "./config.js";
import { ArmoryCache, openDatabase } from "./db.js";
import { RecipeCatalog } from "./recipe-catalog.js";

// Rebuilds the Forever recipe catalog now, e.g. if recipes changed without a new game build.
// The running server picks up the new catalog on its next request. Usage: node dist/refresh-recipes.js
const config = loadConfig();
const bz = config.blizzard;
if (!bz || bz.namespace !== "forever") {
  console.error("The recipe catalog needs BLIZZARD_* configured with BLIZZARD_NAMESPACE=forever.");
  process.exit(1);
}
const db = openDatabase(config.dbPath);
const catalog = new RecipeCatalog(new BlizzardClient(bz), new ArmoryCache(db), bz.region);
try {
  const c = await catalog.rebuild();
  const recipes = c.professions.reduce((n, p) => n + p.total, 0);
  console.log(`Built recipe catalog for build ${c.build}: ${recipes} recipes in ${c.professions.length} professions.`);
} catch (err) {
  console.error(`Recipe catalog build failed: ${(err as Error).message}. The previous catalog is unchanged.`);
  process.exitCode = 1;
} finally {
  db.close();
}
```

In `package.json` scripts, after `"reset-data"`:

```json
    "refresh-recipes": "tsx src/refresh-recipes.ts"
```

- [ ] **Step 2: Typecheck and lint**

Run: `npm run typecheck; npm run lint`
Expected: no output.

- [ ] **Step 3: Run it against the live API**

Run (needs real `BLIZZARD_CLIENT_ID`/`SECRET` in `.env`; uses a scratch DB):
`(set -a; source .env; set +a; GUILD_PASSPHRASE=x-local-only-passphrase SESSION_SECRET=$(openssl rand -hex 32) DB_PATH=/tmp/recipes-check.db npm run refresh-recipes); rm -f /tmp/recipes-check.db*`
Expected: `Built recipe catalog for build 1.60.1_…: ~2480 recipes in 9 professions.` within about a minute.

- [ ] **Step 4: Document**

In `README.md`, after the "Discord announcements" section, add:

```markdown
## Crafting directory

On Forever, the Crafting tab lists every recipe in Alchemy, Blacksmithing,
Enchanting, Engineering, Leatherworking, Tailoring, Cooking, First Aid and
Mining (smelting), who in the guild knows it (with their skill), and its
reagents. Search matches recipe, item and reagent names; "Nobody knows yet"
shows the gaps.

- Known recipes come from each member's armory professions, read by the
  guild sync. Members below level 10 have no armory profile, so none show.
- The recipe catalog (~2,500 recipes) is read from Blizzard's static data
  8 calls at a time, stored in SQLite, and rebuilt when Blizzard's game build
  changes (checked at startup and daily). A failed build keeps the old one.
- To rebuild it by hand (rarely needed):

  ```bash
  npm run refresh-recipes                         # local, uses DB_PATH
  fly ssh console -C "setpriv --reuid=node --regid=node --init-groups node dist/refresh-recipes.js"
  ```
```

Also add `| GET    | /api/crafting      | recipe catalog + who knows each recipe (Forever only; 404 otherwise) |` to the API table after the `/api/armory/character/:name` row.

- [ ] **Step 5: Commit**

```bash
git add src/refresh-recipes.ts package.json README.md
git commit -m "feat: refresh-recipes CLI and crafting docs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Crafting tab

**Files:**
- Create: `public/crafting.js`
- Modify: `public/index.html`, `public/app.js`, `public/style.css`
- Test: `test/crafting-filter.test.ts`

**Interfaces:**
- Consumes: `GET /api/crafting` (Task 3); in `app.js`: `api`, `esc`, `characterName(m, cls)`, `armory.wowheadItemUrl`, `armory.namespace`, `showGate`.
- Produces (in `public/crafting.js`):
  - `export const CAP = 200`
  - `export function filterCatalog(catalog, crafters, { query, profession, mode })` → `{ groups: { profession, category, rows: { recipe, crafters, reagentHits: number[] }[] }[], total, shown }`
  - `export function coverage(catalog, crafters)` → `{ id, name, known, total }[]`
  - `export function renderCrafting(root, data, state, helpers)` where `helpers = { esc, characterName, itemUrl }`

- [ ] **Step 1: Write the failing tests**

Create `test/crafting-filter.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { CAP, coverage, filterCatalog } from "../public/crafting.js";

const recipe = (id: number, name: string, reagents: string[] = []) => ({
  id, name, itemId: id + 1000, itemName: name, makes: 1,
  reagents: reagents.map((r, i) => ({ itemId: i + 1, name: r, quantity: 1 })),
});
const catalog = {
  build: "b",
  builtAt: "t",
  professions: [
    { id: "engineering", name: "Engineering", total: 2, categories: [{ name: "Explosives", recipes: [recipe(1, "Rough Dynamite", ["Linen Cloth"]), recipe(2, "Ez-Thro Dynamite")] }] },
    { id: "tailoring", name: "Tailoring", total: 1, categories: [{ name: "Shirts", recipes: [recipe(3, "Linen Shirt", ["Bolt of Linen Cloth"])] }] },
  ],
};
const crafters = { 1: [{ memberId: 1, characterName: "Darrell", surname: "Deez", skill: 69 }] };
const names = (out: { groups: { rows: { recipe: { name: string } }[] }[] }) => out.groups.flatMap((g) => g.rows.map((r) => r.recipe.name));

test("known mode shows only recipes someone knows; gaps the rest; all everything", () => {
  assert.deepEqual(names(filterCatalog(catalog, crafters, { mode: "known" })), ["Rough Dynamite"]);
  assert.deepEqual(names(filterCatalog(catalog, crafters, { mode: "gaps" })), ["Ez-Thro Dynamite", "Linen Shirt"]);
  assert.deepEqual(names(filterCatalog(catalog, crafters, { mode: "all" })), ["Rough Dynamite", "Ez-Thro Dynamite", "Linen Shirt"]);
});

test("search matches recipe and reagent names, case-insensitively, and flags reagent hits", () => {
  const out = filterCatalog(catalog, crafters, { mode: "all", query: "LINEN" });
  assert.deepEqual(names(out), ["Rough Dynamite", "Linen Shirt"]);
  assert.deepEqual(out.groups[0].rows[0].reagentHits, [1]);
  assert.deepEqual(names(filterCatalog(catalog, crafters, { mode: "all", query: "ez-thro" })), ["Ez-Thro Dynamite"]);
});

test("profession filter and grouping by profession and category", () => {
  const out = filterCatalog(catalog, crafters, { mode: "all", profession: "tailoring" });
  assert.deepEqual(out.groups.map((g: { profession: { id: string }; category: string }) => [g.profession.id, g.category]), [["tailoring", "Shirts"]]);
});

test("results are capped, with the full total reported", () => {
  const many = {
    ...catalog,
    professions: [{ id: "cooking", name: "Cooking", total: 250, categories: [{ name: "Meals", recipes: Array.from({ length: 250 }, (_, i) => recipe(i + 10, `Dish ${i}`)) }] }],
  };
  const out = filterCatalog(many, {}, { mode: "all" });
  assert.equal(out.total, 250);
  assert.equal(out.shown, CAP);
  assert.equal(names(out).length, CAP);
});

test("coverage counts known recipes per profession", () => {
  assert.deepEqual(coverage(catalog, crafters), [
    { id: "engineering", name: "Engineering", known: 1, total: 2 },
    { id: "tailoring", name: "Tailoring", known: 0, total: 1 },
  ]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test test/crafting-filter.test.ts 2>&1 | tail -5`
Expected: FAIL — cannot find `../public/crafting.js`.

- [ ] **Step 3: Implement `public/crafting.js`**

```js
// Crafting directory: filtering is pure (unit tested from Node); rendering takes app helpers.
export const CAP = 200;

// mode: "known" (someone in the guild knows it), "gaps" (nobody does), "all".
export function filterCatalog(catalog, crafters, { query = "", profession = "", mode = "known" } = {}) {
  const q = query.trim().toLowerCase();
  const groups = [];
  let total = 0;
  let shown = 0;
  for (const p of catalog.professions) {
    if (profession && p.id !== profession) continue;
    for (const c of p.categories) {
      const rows = [];
      for (const recipe of c.recipes) {
        const who = crafters[recipe.id] ?? [];
        if (mode === "known" && who.length === 0) continue;
        if (mode === "gaps" && who.length > 0) continue;
        const reagentHits = q ? recipe.reagents.filter((r) => r.name.toLowerCase().includes(q)).map((r) => r.itemId) : [];
        const nameHit = recipe.name.toLowerCase().includes(q) || (recipe.itemName ?? "").toLowerCase().includes(q);
        if (q && !nameHit && reagentHits.length === 0) continue;
        total++;
        if (shown < CAP) {
          rows.push({ recipe, crafters: who, reagentHits });
          shown++;
        }
      }
      if (rows.length) groups.push({ profession: p, category: c.name, rows });
    }
  }
  return { groups, total, shown };
}

export function coverage(catalog, crafters) {
  return catalog.professions.map((p) => ({
    id: p.id,
    name: p.name,
    known: p.categories.reduce((n, c) => n + c.recipes.filter((r) => (crafters[r.id] ?? []).length > 0).length, 0),
    total: p.total,
  }));
}

const link = (url, text, esc) => `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>`;

// Renders the profession chips and results into the Crafting panel.
export function renderCrafting(root, data, state, { esc, characterName, itemUrl }) {
  const chips = root.querySelector("#crafting-profs");
  chips.innerHTML =
    `<button type="button" class="chip" data-profession="" aria-pressed="${state.profession === ""}">All</button>` +
    coverage(data.catalog, data.crafters)
      .map(
        (p) =>
          `<button type="button" class="chip" data-profession="${esc(p.id)}" aria-pressed="${state.profession === p.id}">${esc(p.name)} <b>${p.known}/${p.total}</b></button>`,
      )
      .join("");
  for (const b of root.querySelectorAll("#crafting-mode .chip")) b.setAttribute("aria-pressed", String(b.dataset.mode === state.mode));

  const { groups, total, shown } = filterCatalog(data.catalog, data.crafters, state);
  const row = ({ recipe, crafters, reagentHits }) => {
    const title = recipe.itemId ? link(itemUrl(recipe.itemId), recipe.name, esc) : esc(recipe.name);
    const makes = recipe.makes > 1 ? ` <span class="muted">×${recipe.makes}</span>` : "";
    const who = crafters.length
      ? crafters.map((c) => `${characterName(c, "member")}${c.skill != null ? ` <span class="muted">${c.skill}</span>` : ""}`).join(", ")
      : '<span class="muted">— nobody yet</span>';
    const reagents = recipe.reagents
      .map((r) => {
        const text = `${link(itemUrl(r.itemId), r.name, esc)} ×${r.quantity}`;
        return reagentHits.includes(r.itemId) ? `<mark>${text}</mark>` : text;
      })
      .join(" · ");
    return `<li class="craft-row">
      <div class="craft-name">${title}${makes}</div>
      <div class="craft-who">${who}</div>
      <div class="craft-reagents muted">${reagents}</div>
    </li>`;
  };
  const results = root.querySelector("#crafting-results");
  results.innerHTML =
    (groups.length
      ? groups
          .map((g) => `<section class="craft-group"><h3>${esc(g.profession.name)} · ${esc(g.category)}</h3><ul class="craft-list">${g.rows.map(row).join("")}</ul></section>`)
          .join("")
      : '<p class="muted">No recipes match.</p>') +
    (total > shown ? `<p class="muted">Showing ${shown} of ${total}. Refine your search to see the rest.</p>` : "");
}
```

- [ ] **Step 4: Run the filter tests**

Run: `npx tsx --test test/crafting-filter.test.ts 2>&1 | grep -E "^not ok|^# (pass|fail)"`
Expected: `# fail 0`.

- [ ] **Step 5: Add the tab and panel to `public/index.html`**

In the tabs nav, after the Classes link:

```html
        <a href="#crafting" id="crafting-tab" class="tab hidden" data-tab="crafting">Crafting</a>
```

After the `#class-overview` section, still inside `<section id="roster">`:

```html
      <section id="crafting-panel" class="panel hidden" aria-label="Crafting">
        <h2>Crafting</h2>
        <p id="crafting-status" class="muted" role="status"></p>
        <div id="crafting-controls" class="hidden">
          <input id="crafting-search" type="search" autocomplete="off" placeholder="Search recipes, items or reagents…" aria-label="Search recipes, items or reagents" />
          <div id="crafting-profs" class="filters" role="group" aria-label="Filter by profession"></div>
          <div id="crafting-mode" class="filters" role="group" aria-label="Show">
            <button type="button" class="chip" data-mode="known" aria-pressed="true">Known in guild</button>
            <button type="button" class="chip" data-mode="gaps" aria-pressed="false">Nobody knows yet</button>
            <button type="button" class="chip" data-mode="all" aria-pressed="false">All</button>
          </div>
        </div>
        <div id="crafting-results"></div>
      </section>
```

- [ ] **Step 6: Wire it up in `public/app.js`**

Import at the top:

```js
import { renderCrafting } from "./crafting.js";
```

State, next to `classFilter`:

```js
let crafting = null; // /api/crafting body once ready
let craftingPoll = null;
const craftingState = { query: "", profession: "", mode: "known" };
```

Replace `applyTab` with:

```js
const TABS = ["roster", "classes", "crafting"];

function applyTab() {
  const wanted = location.hash.slice(1);
  const tab = TABS.includes(wanted) && !(wanted === "crafting" && $("#crafting-tab").classList.contains("hidden")) ? wanted : "roster";
  $("#roster-panel").classList.toggle("hidden", tab !== "roster");
  $("#class-overview").classList.toggle("hidden", tab !== "classes");
  $("#crafting-panel").classList.toggle("hidden", tab !== "crafting");
  for (const a of document.querySelectorAll(".tab")) {
    const on = a.dataset.tab === tab;
    a.classList.toggle("active", on);
    if (on) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  if (tab === "crafting") loadCrafting();
}
```

Add after `applyTab`:

```js
// ---------- Crafting ----------
const itemUrl = (id) => armory.wowheadItemUrl + id;

function drawCrafting() {
  if (!crafting) return;
  renderCrafting($("#crafting-panel"), crafting, craftingState, { esc, characterName, itemUrl });
}

async function loadCrafting() {
  if (crafting) return drawCrafting();
  clearTimeout(craftingPoll);
  const r = await api("GET", "/api/crafting");
  if (r.status === 401) return showGate("Your session expired. Enter the passphrase again.");
  const status = r.ok ? r.data.status : "unavailable";
  $("#crafting-status").textContent =
    status === "building" ? "Building the recipe catalog…" : status === "unavailable" ? "The recipe catalog is unavailable right now." : "";
  if (status === "building") {
    craftingPoll = setTimeout(() => {
      if (location.hash === "#crafting") loadCrafting();
    }, 5000);
    return;
  }
  if (status !== "ready") return;
  crafting = r.data;
  $("#crafting-controls").classList.remove("hidden");
  drawCrafting();
}
```

In `initArmory`, after `if (!armory) return;`:

```js
  // The crafting directory needs Forever's recipe catalog.
  $("#crafting-tab").classList.toggle("hidden", armory.namespace !== "forever");
  applyTab();
```

Where members are (re)loaded — at the end of `loadMembers()` before `return true;` — drop the cached crafting data so crafters stay current:

```js
  crafting = null;
  // Needs the armory status (Wowhead URL); initArmory reloads the tab once it arrives.
  if (armory && location.hash === "#crafting") loadCrafting();
```

Event listeners, next to the class-filter listener:

```js
$("#crafting-search").addEventListener("input", (e) => {
  craftingState.query = e.target.value;
  drawCrafting();
});
$("#crafting-profs").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-profession]");
  if (!btn) return;
  craftingState.profession = btn.dataset.profession;
  drawCrafting();
});
$("#crafting-mode").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-mode]");
  if (!btn) return;
  craftingState.mode = btn.dataset.mode;
  drawCrafting();
});
```

Crafter names render with `characterName(c, "member")`, which emits `data-action="armory"` buttons; the existing `#roster` click handler opens the armory for them because `#crafting-panel` sits inside `#roster`.

- [ ] **Step 7: Styles in `public/style.css`**

Append:

```css
/* Crafting directory */
#crafting-search { width: 100%; margin: 0 0 10px; }
.craft-group { margin: 16px 0 0; }
.craft-group h3 { margin: 0 0 6px; font-size: 14px; color: var(--gold); text-transform: uppercase; letter-spacing: 0.04em; }
.craft-list { list-style: none; margin: 0; padding: 0; }
.craft-row {
  display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 1.4fr); gap: 4px 16px;
  padding: 8px 6px; border-bottom: 1px solid rgba(107, 90, 51, 0.4);
}
.craft-name a, .craft-reagents a { color: var(--text); }
.craft-reagents { font-size: 0.9em; }
.craft-reagents mark { background: rgba(201, 133, 0, 0.25); color: inherit; padding: 0 2px; }
@media (max-width: 720px) {
  .craft-row { grid-template-columns: 1fr; }
}
```

- [ ] **Step 8: Full checks**

Run: `npm test 2>&1 | grep -E "^not ok|^# (pass|fail)"; npm run typecheck; npm run lint`
Expected: `# fail 0`; no other output.

- [ ] **Step 9: Commit**

```bash
git add public/crafting.js public/index.html public/app.js public/style.css test/crafting-filter.test.ts
git commit -m "feat: Crafting tab with search, profession coverage and gaps

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Live verification

**Files:** none (verification only).

- [ ] **Step 1: Run locally against the live API**

```bash
S=$(mktemp -d)
(set -a; source .env; set +a; GUILD_PASSPHRASE=local-test-passphrase SESSION_SECRET=$(openssl rand -hex 32) PORT=3917 DB_PATH=$S/smoke.db DISCORD_WEBHOOK_URL= npx tsx src/server.ts > $S/server.log 2>&1 &)
sleep 60   # catalog build + first sync
J=$S/cj
curl -s -c $J -o /dev/null -H 'content-type: application/json' -d '{"passphrase":"local-test-passphrase"}' localhost:3917/api/login
curl -s -b $J localhost:3917/api/members > /dev/null; sleep 30
curl -s -b $J -H 'accept-encoding: gzip' -o /dev/null -w "crafting %{http_code} %{size_download} bytes gzip\n" localhost:3917/api/crafting
curl -s -b $J localhost:3917/api/crafting | python3 -I -c 'import json,sys;d=json.load(sys.stdin);c=d["catalog"];print(d["status"],c["build"],sum(p["total"] for p in c["professions"]),"recipes;",len(d["crafters"]),"known by someone")'
```

Expected: `crafting 200` with a gzip size well under 100 KB; `ready 1.60.1_… ~2480 recipes; N known by someone` with N > 0.

- [ ] **Step 2: Browser check**

Open `http://localhost:3917/#crafting`, log in, and confirm: the Crafting tab is visible; profession chips show `known/total`; searching "linen cloth" lists recipes using it with the reagent highlighted; "Nobody knows yet" shows unknown recipes; a crafter name opens their armory; Wowhead links open the item. Check at phone width (cards, no horizontal scroll).

- [ ] **Step 3: Stop the server**

Run: `pkill -f "tsx src/server.ts"; rm -rf "$S"`
