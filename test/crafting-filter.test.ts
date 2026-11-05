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
