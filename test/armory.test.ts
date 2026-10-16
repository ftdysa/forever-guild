import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { ArmoryService, inferSpec, mapProfessions } from "../src/armory.js";
import { BlizzardClient } from "../src/blizzard.js";
import { ArmoryCache } from "../src/db.js";
import { BASE, fakeBlizzard, guildFixture } from "./fake-blizzard.js";

const cfg = { region: "us", namespace: "classic1x", realm: "doomhowl", guild: "fatal" };
const creds = { clientId: "id", clientSecret: "shh", region: "us", namespace: "classic1x" };

function setup(routes: Record<string, unknown> = guildFixture()) {
  let t = 1_000_000;
  const fake = fakeBlizzard(routes);
  const db = new Database(":memory:");
  const cache = new ArmoryCache(db);
  const armory = new ArmoryService(new BlizzardClient(creds, fake.fetchFn), cache, cfg, () => t);
  return { fake, armory, cache, advance: (ms: number) => (t += ms) };
}

const tree = (name: string, pts: number) => ({ specialization_name: name, spent_points: pts });

test("inferSpec picks the deepest tree of the active group", () => {
  const raw = {
    specialization_groups: [
      { is_active: false, specializations: [tree("Fire", 51)] },
      { is_active: true, specializations: [tree("Beast Mastery", 31), tree("Marksmanship", 20)] },
    ],
  };
  assert.deepEqual(inferSpec("hunter", raw), { specId: "beast-mastery", points: { "beast-mastery": 31, marksmanship: 20 } });
  assert.equal(inferSpec("druid", { specialization_groups: [{ specializations: [tree("Feral Combat", 31)] }] })?.specId, "feral-combat");
});

test("inferSpec gives up on ties, empty builds, unknown trees, or unknown class", () => {
  assert.equal(inferSpec("mage", { specialization_groups: [{ is_active: true, specializations: [tree("Fire", 20), tree("Frost", 20)] }] }), null);
  assert.equal(inferSpec("mage", { specialization_groups: [{ is_active: true, specializations: [] }] }), null);
  assert.equal(inferSpec("mage", { specialization_groups: [] }), null);
  assert.equal(inferSpec("mage", null), null);
  assert.equal(inferSpec("mage", { specialization_groups: [{ specializations: [tree("Shadow", 31)] }] }), null);
  assert.equal(inferSpec(null, { specialization_groups: [{ specializations: [tree("Frost", 31)] }] }), null);
});

test("mapProfessions maps known names and drops the rest", () => {
  const raw = {
    primaries: [{ profession: { name: "Herbalism" } }, { profession: { name: "Inscription" } }, { profession: { name: "Alchemy" } }],
    secondaries: [{ profession: { name: "Cooking" } }, { profession: { name: "Archaeology" } }],
  };
  assert.deepEqual(mapProfessions(raw), { primary: ["herbalism", "alchemy"], secondary: ["cooking"] });
  assert.equal(mapProfessions(null), null);
});

test("roster maps classes, sorts by name, and leaves unknown classes null", async () => {
  const { armory } = setup();
  assert.deepEqual(await armory.roster(), [
    { name: "Jaina", level: 60, classId: "mage", rank: 1 },
    { name: "Oddball", level: 10, classId: null, rank: 7 },
    { name: "Zuljin", level: 42, classId: "hunter", rank: 4 },
  ]);
});

test("character maps profile, gear, spec, avatar; professions null when unsupported", async () => {
  const { armory } = setup();
  const c = await armory.character("Jaina");
  assert.ok(c);
  assert.equal(c.classId, "mage");
  assert.equal(c.itemLevel, 66);
  assert.equal(c.lastLogin, "2026-10-01T00:00:00.000Z");
  assert.equal(c.spec?.specId, "frost");
  assert.equal(c.professions, null);
  assert.match(c.avatarUrl ?? "", /^https:\/\/render\.worldofwarcraft\.com\//);
  assert.deepEqual(c.gear[0], { slot: "Head", name: "Frostfire Circlet", quality: "epic", itemId: 22498 });
  assert.equal(await armory.character("Nobody"), null);
});

test("avatar from any other host is dropped", async () => {
  const routes = guildFixture();
  routes[`${BASE}/jaina/character-media`] = { assets: [{ key: "avatar", value: "https://evil.example/x.jpg" }] };
  const { armory } = setup(routes);
  assert.equal((await armory.character("jaina"))?.avatarUrl, null);
});

test("character professions are mapped when the endpoint exists", async () => {
  const routes = guildFixture();
  routes[`${BASE}/jaina/professions`] = { primaries: [{ profession: { name: "Tailoring" } }], secondaries: [] };
  const { armory } = setup(routes);
  assert.deepEqual((await armory.character("jaina"))?.professions, { primary: ["tailoring"], secondary: [] });
});

test("results are cached until the TTL, keyed case-insensitively", async () => {
  const { armory, fake, advance } = setup();
  await armory.character("Jaina");
  const after = fake.calls.length;
  await armory.character("JAINA");
  assert.equal(fake.calls.length, after);
  advance(3 * 60 * 60 * 1000);
  await armory.character("jaina");
  assert.ok(fake.calls.length > after);
});

test("stale cache is served when Blizzard is down; errors surface without a cache", async () => {
  const { armory, fake, advance } = setup();
  await armory.roster();
  advance(7 * 60 * 60 * 1000);
  fake.state.apiDown = true;
  assert.equal((await armory.roster()).length, 3);
  await assert.rejects(armory.character("jaina"), /unreachable/);
});

test("cache keys include realm and guild so a new guild never sees old data", async () => {
  const { cache } = setup();
  const fake = fakeBlizzard(guildFixture());
  const a = new ArmoryService(new BlizzardClient(creds, fake.fetchFn), cache, cfg);
  await a.roster();
  const b = new ArmoryService(new BlizzardClient(creds, fake.fetchFn), cache, { ...cfg, guild: "other" });
  await assert.rejects(b.roster(), /guild not found/);
});
