import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { ArmoryService, inferSpec, mapProfessions, mapStats, type RawItem } from "../src/armory.js";
import { BlizzardClient } from "../src/blizzard.js";
import { ArmoryCache } from "../src/db.js";
import { BASE, ICONS, fakeBlizzard, guildFixture, iconSearch } from "./fake-blizzard.js";

const cfg = { region: "us", namespace: "classic1x", realm: "doomhowl", guild: "fatal" };
const creds = { clientId: "id", clientSecret: "shh", region: "us", namespace: "classic1x" };

function setup(routes: Record<string, unknown> = guildFixture(), config = cfg) {
  let t = 1_000_000;
  const fake = fakeBlizzard(routes);
  const db = new Database(":memory:");
  const cache = new ArmoryCache(db);
  const client = new BlizzardClient({ ...creds, namespace: config.namespace }, fake.fetchFn);
  const armory = new ArmoryService(client, cache, config, () => t);
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
  assert.match(c.renderUrl ?? "", /main-raw\.png$/);
  assert.equal(c.faction, "alliance");
  assert.deepEqual(c.stats, {
    health: 4200, powerName: "Mana", power: 6100,
    strength: 35, agility: 40, stamina: 210, intellect: 290, spirit: 150, crit: 9.26,
  });
  assert.equal(await armory.character("Nobody"), null);
});

test("gear carries slot, icon, and Blizzard's tooltip lines", async () => {
  const { armory } = setup();
  const [helm, staff, shirt] = (await armory.character("jaina"))!.gear;
  assert.equal(helm.slot, "HEAD");
  assert.equal(helm.slotName, "Head");
  assert.equal(helm.icon, "https://render.worldofwarcraft.com/classic1x-us/icons/56/inv_crown_01.jpg");
  assert.deepEqual(helm.tooltip, {
    binding: "Binds when picked up",
    unique: null,
    slotLabel: "Head",
    typeLabel: "Cloth",
    damage: null,
    speed: null,
    dps: null,
    armor: "98 Armor",
    stats: ["+23 Stamina", "+27 Intellect"],
    enchantments: ["Enchanted: +8 Intellect"],
    durability: "Durability 60 / 60",
    requiredLevel: "Requires Level 60",
    spells: ["Equip: Increases damage and healing done by magical spells and effects by up to 35."],
    set: {
      name: "Frostfire Regalia (2/9)",
      items: [
        { name: "Frostfire Circlet", equipped: true },
        { name: "Frostfire Robe", equipped: true },
        { name: "Frostfire Sandals", equipped: false },
      ],
      effects: [
        { text: "(2) Set: Your Arcane Missiles refund 10% of their mana cost.", active: true },
        { text: "(4) Set: Chance on spell cast to gain 200 mana.", active: false },
      ],
    },
    description: null,
  });
  assert.equal(staff.tooltip.damage, "124 - 207 Damage");
  assert.equal(staff.tooltip.speed, "Speed 2.90");
  assert.equal(staff.tooltip.unique, "Unique");
  assert.equal(staff.tooltip.description, "Guardian of the Tirisfal.");
  // icon from a non-Blizzard host is dropped; missing icon is null
  assert.equal(staff.icon, null);
  assert.equal(shirt.icon, null);
  assert.equal(shirt.tooltip.typeLabel, null);
});

const searches = (calls: string[]) => calls.filter((c) => c === "/data/wow/search/media").length;

test("all of a character's icons come from one media search", async () => {
  const { armory, fake } = setup();
  await armory.character("jaina");
  assert.equal(searches(fake.calls), 1);
  // per-character profile calls: summary, equipment, specializations, media, statistics
  assert.equal(fake.calls.filter((c) => c.startsWith(BASE)).length, 5);
});

test("cached icons (including items without one) are not searched again", async () => {
  const { armory, fake, advance } = setup();
  await armory.character("jaina");
  advance(4 * 60 * 60 * 1000); // character stale, icons still fresh
  await armory.character("jaina");
  assert.equal(searches(fake.calls), 1);
});

test("icon searches are batched 100 ids at a time", async () => {
  const routes = guildFixture();
  const equipment = routes[`${BASE}/jaina/equipment`] as { equipped_items: RawItem[] };
  const shirt = equipment.equipped_items[2];
  equipment.equipped_items = Array.from({ length: 150 }, (_, n) => ({ ...shirt, item: { id: 1000 + n } }));
  const fake = fakeBlizzard(routes);
  const batchSizes: number[] = [];
  const counting: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/data/wow/search/media") batchSizes.push((url.searchParams.get("id") ?? "").split("||").length);
    return fake.fetchFn(input, init);
  };
  const armory = new ArmoryService(new BlizzardClient(creds, counting), new ArmoryCache(new Database(":memory:")), cfg);
  await armory.character("jaina");
  assert.deepEqual(batchSizes, [100, 50]);
});

test("icon search failures degrade to null and fill in once Blizzard recovers", async () => {
  const routes: Record<string, unknown> = guildFixture();
  routes["/data/wow/search/media"] = { status: 503 };
  const { armory, fake, advance } = setup(routes);
  const c = await armory.character("jaina");
  assert.equal(c?.gear[0].icon, null);
  assert.equal(c?.gear[0].name, "Frostfire Circlet");

  // Character unchanged (304), but its blank icons are retried rather than cached forever.
  routes["/data/wow/search/media"] = iconSearch;
  advance(20 * 60 * 1000);
  assert.equal((await armory.character("jaina"))?.gear[0].icon, ICONS[22498]);
  assert.equal(searches(fake.calls), 2);
  assert.equal(profileCalls(fake.calls), 6);

  // Remaining blanks are items known to have no icon: no further searches.
  advance(20 * 60 * 1000);
  await armory.character("jaina");
  assert.equal(searches(fake.calls), 2);
});

test("mapStats picks the best crit and tolerates missing data", () => {
  assert.equal(mapStats(null), null);
  assert.equal(mapStats({}), null);
  assert.deepEqual(mapStats({ health: 100, melee_crit: { value: 3 } }), {
    health: 100, powerName: "Power", power: 0, strength: 0, agility: 0, stamina: 0, intellect: 0, spirit: 0, crit: 3,
  });
});

test("avatar from any other host is dropped", async () => {
  const routes = guildFixture();
  routes[`${BASE}/jaina/character-media`] = { assets: [{ key: "avatar", value: "https://evil.example/x.jpg" }] };
  const { armory } = setup(routes);
  assert.equal((await armory.character("jaina"))?.avatarUrl, null);
});

test("character professions are mapped where the endpoint exists (not Classic Era)", async () => {
  const routes = guildFixture();
  routes[`${BASE}/jaina/professions`] = { primaries: [{ profession: { name: "Tailoring" } }], secondaries: [] };
  const { armory } = setup(routes, { ...cfg, namespace: "retail" });
  assert.deepEqual((await armory.character("jaina"))?.professions, { primary: ["tailoring"], secondary: [] });
});

test("Classic Era skips the professions call entirely", async () => {
  const { armory, fake } = setup();
  await armory.character("jaina");
  assert.ok(!fake.calls.some((c) => c.endsWith("/professions")));
});

const profileCalls = (calls: string[]) => calls.filter((c) => c.startsWith(BASE)).length;

test("characters are served from cache for 15 minutes, keyed case-insensitively", async () => {
  const { armory, fake, advance } = setup();
  await armory.character("Jaina");
  const after = fake.calls.length;
  advance(14 * 60 * 1000);
  await armory.character("JAINA");
  assert.equal(fake.calls.length, after);
});

test("after 15 minutes an unchanged character costs one conditional call", async () => {
  const { armory, fake, advance } = setup();
  const first = await armory.character("jaina");
  assert.equal(profileCalls(fake.calls), 5);
  advance(30 * 24 * 60 * 60 * 1000); // long gaps are fine: there is no hard expiry
  assert.deepEqual(await armory.character("jaina"), first);
  assert.equal(profileCalls(fake.calls), 6);
  // the 304 renewed freshness, so the next view within 15 minutes is free
  advance(5 * 60 * 1000);
  await armory.character("jaina");
  assert.equal(profileCalls(fake.calls), 6);
});

test("a character who played since is refetched in full", async () => {
  const routes = guildFixture();
  const { armory, fake, advance } = setup(routes);
  await armory.character("jaina");
  (routes[`${BASE}/jaina`] as { equipped_item_level: number }).equipped_item_level = 71;
  fake.state.lastModified = "Fri, 16 Oct 2026 12:00:00 GMT";
  advance(20 * 60 * 1000);
  assert.equal((await armory.character("jaina"))?.itemLevel, 71);
  assert.equal(profileCalls(fake.calls), 10);
  // and the new Last-Modified is what gets revalidated next
  advance(20 * 60 * 1000);
  await armory.character("jaina");
  assert.equal(profileCalls(fake.calls), 11);
});

test("unknown characters are rechecked with one call after 15 minutes", async () => {
  const { armory, fake, advance } = setup();
  assert.equal(await armory.character("nobody"), null);
  assert.equal(await armory.character("nobody"), null);
  assert.equal(fake.calls.filter((c) => c.endsWith("/nobody")).length, 1);
  advance(20 * 60 * 1000);
  await armory.character("nobody");
  assert.equal(fake.calls.filter((c) => c.endsWith("/nobody")).length, 2);
});

test("a cached character is served when revalidation fails", async () => {
  const { armory, fake, advance } = setup();
  const first = await armory.character("jaina");
  advance(20 * 60 * 1000);
  fake.state.apiDown = true;
  assert.deepEqual(await armory.character("jaina"), first);
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
