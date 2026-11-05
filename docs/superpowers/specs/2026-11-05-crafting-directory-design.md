# Crafting Directory — Design

Date: 2026-11-05

## Purpose

Answer "who in the guild can craft X?" and "which recipes does nobody know
yet?" from armory data, without anyone entering recipes by hand.

## Decisions (from brainstorming)

- Scope: lookup plus gaps. No request board.
- Professions: Alchemy, Blacksmithing, Enchanting, Engineering,
  Leatherworking, Tailoring, Cooking, First Aid, and Mining (smelting makes
  bars). Herbalism, Skinning and Fishing are left out: their "recipes" are
  abilities, not items.
- Data: prefetch the whole recipe catalog, reagents included, so search can
  match reagents ("what uses Linen Cloth?").
- Cache: rebuilt automatically when Blizzard's game build changes, plus a
  manual `npm run refresh-recipes` for the rare case recipes change without a
  new build.
- UI: a third tab, Crafting. The whole catalog is loaded once and filtered in
  the browser.
- Forever only for now: the build check and profession ids come from the
  `static-forever-<region>` namespace. Other flavours get no Crafting tab
  (`/api/crafting` answers 404).

## Data available (verified against static-forever-us, 2026-11-05)

- `GET /data/wow/profession/index`: profession ids and names
  (Tailoring 197, Cooking 185, Leatherworking 165, Enchanting 333, Mining 186,
  Blacksmithing 164, Engineering 202, Alchemy 171, First Aid 129). Also lists
  a "Test Profession [DNT]", which is ignored.
- `GET /data/wow/profession/{id}`: one skill tier per profession (Forever is
  Classic-style).
- `GET /data/wow/profession/{id}/skill-tier/{tier}`: `categories[]`, each
  `{ name, recipes: [{ id, name }] }`. ~2,480 recipes in total across the nine
  professions (Mining 17 … Leatherworking 592).
- `GET /data/wow/recipe/{id}`: `crafted_item { id, name }`,
  `reagents [{ reagent { id, name }, quantity }]`,
  `crafted_quantity { value }`. Some recipes (enchants, smelting) may have no
  `crafted_item`.
- Every static response's `_links.self.href` carries the resolved namespace,
  e.g. `static-1.60.1_70399-forever-us`. The part before `-forever-` is the
  game build.
- Character professions (`/profile/wow/character/{slug}/professions`) list
  `tiers[0].known_recipes [{ id, name }]` per profession. The guild sync
  already fetches this endpoint.

## Data and caching

### Catalog

`RecipeCatalog` (new, `src/recipe-catalog.ts`) builds:

```ts
interface Catalog {
  build: string;            // e.g. "1.60.1_70399"
  builtAt: string;          // ISO time
  professions: {
    id: string;             // our profession id, e.g. "engineering"
    name: string;
    total: number;          // recipes in the catalog for this profession
    categories: {
      name: string;
      recipes: {
        id: number;
        name: string;
        itemId: number | null;   // crafted item, null for enchants etc.
        makes: number;           // crafted quantity, default 1
        reagents: { itemId: number; name: string; quantity: number }[];
      }[];
    }[];
  }[];
}
```

- Build: profession index → each included profession → its skill tier →
  every recipe's details. Static calls run through `mapLimit` 8 at a time
  (~2,500 calls, about half a minute).
- Storage: one entry in the existing `armory_cache` table, key
  `<region>:forever:recipes:v1`. It is parsed once and kept in memory until
  the cache entry's `fetchedAt` changes (another process, e.g. the CLI,
  rebuilt it).
- Single flight: concurrent `ensure()` / `rebuild()` calls share one build.
- Atomic: a build is written only when complete. A failed build leaves the
  previous catalog in place. A recipe whose details call fails (non-404
  error) fails the whole build; a 404 on a recipe keeps it with its name,
  `itemId: null`, `makes: 1` and no reagents.

### When it builds

- Startup: if no catalog is cached, build in the background.
- Daily: a timer (same pattern as the guild sync timer, `unref`ed, cleared on
  close) fetches the profession index (1 call), reads the build from its
  `self` link, and rebuilds when it differs from the cached catalog's build.
  Fly stops idle machines, so the check also runs on startup.
- Manual: `npm run refresh-recipes` (`src/refresh-recipes.ts`, mirroring
  `reset-data`) builds the catalog with the configured Blizzard credentials
  and writes it to `DB_PATH`. The running server picks it up on its next
  request. On Fly:
  `fly ssh console -C "setpriv --reuid=node --regid=node --init-groups node dist/refresh-recipes.js"`.

### Known recipes per member

- `mapProfessions` also returns `recipes: number[]`, the known recipe ids
  across all professions.
- `MemberArmory` gains `recipes: number[]`. The guild sync stores it with the
  rest of the armory snapshot; no new Blizzard calls.
- Members without an armory snapshot (under level 10, or not yet synced) know
  no recipes as far as the directory is concerned.

## API

`GET /api/crafting` (session required, like every other route):

```ts
{
  status: "ready" | "building" | "unavailable";
  catalog: Catalog | null;        // null unless ready
  // recipe id → members who know it, highest skill first
  crafters: Record<number, { memberId: number; name: string; skill: number | null }[]>;
}
```

- `building`: no catalog cached yet and a build is running.
- `unavailable`: no catalog cached and the last build failed.
- When a rebuild is running but an older catalog exists, the status is
  `ready` with the old catalog.
- `name` is the member's full name (with surname); `skill` is their current
  skill in that recipe's profession, from the armory snapshot.
- Responses are compressed (`@fastify/compress`, registered for JSON only).
- 404 when the armory is disabled or the namespace isn't `forever`.

## UI (Crafting tab)

- Third tab after Roster and Classes, hash `#crafting`. Hidden when
  `/api/crafting` answers 404.
- Controls, in one row above the results:
  - Search box: case-insensitive substring match on recipe name, crafted
    item name, and reagent names. Matching reagents are highlighted.
  - Profession chips: "All" plus one per profession with
    `known/total` (e.g. "Engineering 11/275"). Single select.
  - Mode: Known in guild (default) · Nobody knows yet · All.
- Results grouped by profession, then Blizzard's category, in catalog order.
  Each recipe row:
  - Recipe name linking to the crafted item on Wowhead
    (`wowheadItemUrl` + item id; plain text when `itemId` is null), with
    "×N" when it makes more than one.
  - Crafters: full names (armory links, as on the roster) with skill, or
    "— nobody yet".
  - Reagents: `Name ×qty`, each linking to Wowhead.
- Results are capped at 200 rows with a "Showing 200 of N, refine your
  search" note, so a blank "All" view doesn't render 2,500 rows.
- `status: building` shows "Building the recipe catalog…" and re-requests
  every 5 seconds until ready. `unavailable` shows "The recipe catalog is
  unavailable right now."
- Mobile: rows become cards, as on the roster.
- Rendering lives in `public/crafting.js`, with a pure
  `filterCatalog(catalog, crafters, { query, profession, mode })` that returns
  the grouped, capped rows. All user-supplied and Blizzard-supplied text is
  escaped (`esc`) or set with `textContent`.

## Components

| Unit | Change |
|---|---|
| `src/recipe-catalog.ts` | new: build, cache, single flight, build check |
| `src/armory.ts` | `mapProfessions` returns known recipe ids |
| `src/db.ts` | `MemberArmory.recipes` |
| `src/guild-sync.ts` | snapshot includes `recipes` |
| `src/routes/crafting.ts` | new: `GET /api/crafting` |
| `src/app.ts` | create the catalog, startup build, daily timer, compression |
| `src/refresh-recipes.ts` | new CLI; `package.json` script |
| `public/crafting.js` | new: `filterCatalog` + tab rendering |
| `public/index.html`, `public/app.js`, `public/style.css` | tab, wiring, styles |
| `README.md` | Crafting section, refresh command |

## Testing

- Catalog builder (fake Blizzard): builds the expected shape; skips excluded
  professions and the test profession; a 404 recipe is kept without
  reagents; concurrent calls share one build; a failed rebuild keeps the old
  catalog; `checkBuild` rebuilds only when the build changes; a catalog
  written by another process is picked up.
- Armory/sync: known recipe ids land in the member snapshot.
- API: 404 when not Forever or armory disabled; `building` then `ready`;
  crafters joined and sorted by skill; session required.
- `filterCatalog` (Node, like `class-overview.test.ts`): search by recipe,
  item and reagent; profession filter; known / gaps / all modes; the 200-row
  cap.
- Live: build the catalog against static-forever-us and check counts; browser
  check of the tab (search, chips, modes, building state).

## Out of scope

- Request board, reagent cost or auction prices (no Forever auction API).
- Where unknown recipes are learned (trainer, vendor, drop): not in the API.
- Recipe skill requirements: not in the API.
- Classic Era / retail support.
