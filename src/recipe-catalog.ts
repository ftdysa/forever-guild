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
  const { professionOf } = recipeIndex(catalog);
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
  private failedAtMs: number | null = null;

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

  // When the most recent build failed (injected clock); null if it did not.
  failedAt(): number | null {
    return this.failed ? this.failedAtMs : null;
  }

  // Milliseconds since the most recent failure (injected clock); null if the last build did not fail.
  failedFor(): number | null {
    const at = this.failedAt();
    return at === null ? null : this.now() - at;
  }

  rebuild(): Promise<Catalog> {
    this.building ??= this.build()
      .then((catalog) => {
        this.cache.set(this.key, catalog, this.now());
        this.failed = false;
        this.failedAtMs = null;
        return catalog;
      })
      .catch((err: unknown) => {
        this.failed = true;
        this.failedAtMs = this.now();
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
      // An unrecognised self link cannot prove a change, so keep the stored catalog.
      if (build === null || stored.build === build) return false;
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
      if (!prof || tierId === undefined) throw new BlizzardError(`profession ${p.blizzardId} not found`);
      const tier = await this.client.gameData<RawSkillTier>(`/data/wow/profession/${p.blizzardId}/skill-tier/${tierId}`);
      if (!tier) throw new BlizzardError(`profession ${p.blizzardId} not found`);
      const categories = tier.categories ?? [];
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
