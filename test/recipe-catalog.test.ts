import { test } from "node:test";
import assert from "node:assert/strict";
import { BlizzardClient } from "../src/blizzard.js";
import { ArmoryCache, openDatabase, type Member } from "../src/db.js";
import { buildOf, craftersByRecipe, recipeIndex, RecipeCatalog, type Catalog } from "../src/recipe-catalog.js";
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
  const client = new BlizzardClient({ clientId: "id", clientSecret: "s", region: "us", namespace: "forever" }, fake.fetchFn, undefined, async () => {});
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

test("a missing skill tier fails the build and keeps the stored catalog", async () => {
  const r = routes();
  const { catalog } = setup(r);
  const first = await catalog.rebuild();
  delete r["/data/wow/profession/202/skill-tier/2941"];
  await assert.rejects(catalog.rebuild(), /profession 202 not found/);
  assert.deepEqual(catalog.current(), first);
  assert.equal(catalog.hasFailed(), true);
});

test("checkBuild keeps the stored catalog when the self link has no build", async () => {
  const r = routes();
  const { catalog, fake } = setup(r);
  await catalog.rebuild();
  const detailCalls = () => fake.calls.filter((p) => p.startsWith("/data/wow/recipe/")).length;
  const before = detailCalls();
  (r["/data/wow/profession/index"] as { _links: unknown })._links = { self: { href: "https://us.api.blizzard.com/x?namespace=static-us" } };
  assert.equal(await catalog.checkBuild(), false);
  assert.equal(detailCalls(), before);
  assert.equal(catalog.current()?.build, "1.60.1_70399");
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

test("failedAt records the failure time and clears on a successful build", async () => {
  const r = routes();
  r["/data/wow/profession/index"] = { status: 500 };
  const { catalog, fake } = setup(r);
  assert.equal(catalog.failedAt(), null);
  assert.equal(catalog.failedFor(), null);
  await assert.rejects(catalog.checkBuild());
  const at = catalog.failedAt();
  assert.equal(typeof at, "number");
  assert.ok((catalog.failedFor() ?? -1) > 0);
  fake.state.apiDown = false;
  (r as Record<string, unknown>)["/data/wow/profession/index"] = routes()["/data/wow/profession/index"];
  await catalog.rebuild();
  assert.equal(catalog.failedAt(), null);
});

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
