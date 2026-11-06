import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { ArmoryService, inferSpec, mapProfessions, mapSweatStats, mapStats, milestoneOf, type RawItem } from "../src/armory.js";
import { BlizzardClient } from "../src/blizzard.js";
import { ArmoryCache } from "../src/db.js";
import { BASE, ICONS, fakeBlizzard, characterFixture, iconSearch } from "./fake-blizzard.js";

const cfg = { region: "us", namespace: "classic1x", realm: "doomhowl", guild: "fatal" };
const creds = { clientId: "id", clientSecret: "shh", region: "us", namespace: "classic1x" };

function setup(routes: Record<string, unknown> = characterFixture(), config: ConstructorParameters<typeof ArmoryService>[2] = cfg, cache = new ArmoryCache(new Database(":memory:"))) {
  let t = 1_000_000;
  const fake = fakeBlizzard(routes);
  const client = new BlizzardClient({ ...creds, namespace: config.namespace }, fake.fetchFn, undefined, async () => {});
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
  // per-character profile calls, one parallel round after the summary: equipment, specializations,
  // media, statistics, reputations, pvp-summary, achievements/statistics (no professions or Legacy achievements on Classic Era)
  assert.equal(fake.calls.filter((c) => c.startsWith(BASE)).length, 8);
});

test("cached icons (including items without one) are not searched again", async () => {
  const { armory, fake, advance } = setup();
  await armory.character("jaina");
  advance(4 * 60 * 60 * 1000); // character stale, icons still fresh
  await armory.character("jaina");
  assert.equal(searches(fake.calls), 1);
});

test("icon searches are batched 100 ids at a time", async () => {
  const routes = characterFixture();
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
  const armory = new ArmoryService(new BlizzardClient(creds, counting, undefined, async () => {}), new ArmoryCache(new Database(":memory:")), cfg);
  await armory.character("jaina");
  assert.deepEqual(batchSizes, [100, 50]);
});

test("icon search failures degrade to null and fill in once Blizzard recovers", async () => {
  const routes: Record<string, unknown> = characterFixture();
  routes["/data/wow/search/media"] = { status: 503 };
  const { armory, fake, advance } = setup(routes);
  const c = await armory.character("jaina");
  assert.equal(c?.gear[0].icon, null);
  assert.equal(c?.gear[0].name, "Frostfire Circlet");
  assert.equal(searches(fake.calls), 4); // the 503 is retried 3 times

  // Character unchanged (304), but its blank icons are retried rather than cached forever.
  routes["/data/wow/search/media"] = iconSearch;
  advance(20 * 60 * 1000);
  assert.equal((await armory.character("jaina"))?.gear[0].icon, ICONS[22498]);
  assert.equal(searches(fake.calls), 5);
  assert.equal(profileCalls(fake.calls), 9);

  // Remaining blanks are items known to have no icon: no further searches.
  advance(20 * 60 * 1000);
  await armory.character("jaina");
  assert.equal(searches(fake.calls), 5);
});

test("mapStats picks the best crit and tolerates missing data", () => {
  assert.equal(mapStats(null), null);
  assert.equal(mapStats({}), null);
  assert.deepEqual(mapStats({ health: 100, melee_crit: { value: 3 } }), {
    health: 100, powerName: "Power", power: 0, strength: 0, agility: 0, stamina: 0, intellect: 0, spirit: 0, crit: 3,
  });
});

test("avatar from any other host is dropped", async () => {
  const routes = characterFixture();
  routes[`${BASE}/jaina/character-media`] = { assets: [{ key: "avatar", value: "https://evil.example/x.jpg" }] };
  const { armory } = setup(routes);
  assert.equal((await armory.character("jaina"))?.avatarUrl, null);
});

test("character professions are mapped where the endpoint exists (not Classic Era)", async () => {
  const routes = characterFixture();
  routes[`${BASE}/jaina/professions`] = { primaries: [{ profession: { name: "Tailoring" } }], secondaries: [] };
  const { armory } = setup(routes, { ...cfg, namespace: "retail" });
  assert.deepEqual((await armory.character("jaina"))?.professions, { primary: ["tailoring"], secondary: [], skills: {}, recipes: [] });
});

test("Classic Era skips the professions call entirely", async () => {
  const { armory, fake } = setup();
  await armory.character("jaina");
  assert.ok(!fake.calls.some((c) => c.endsWith("/professions")));
});

const profileCalls = (calls: string[]) => calls.filter((c) => c.startsWith(BASE)).length;

test("characters are served from cache for 4 minutes, keyed case-insensitively", async () => {
  const { armory, fake, advance } = setup();
  await armory.character("Jaina");
  const after = fake.calls.length;
  advance(3 * 60 * 1000);
  await armory.character("JAINA");
  assert.equal(fake.calls.length, after);
});

test("after 4 minutes an unchanged character costs one conditional call", async () => {
  const { armory, fake, advance } = setup();
  const first = await armory.character("jaina");
  assert.equal(profileCalls(fake.calls), 8);
  advance(30 * 24 * 60 * 60 * 1000); // long gaps are fine: there is no hard expiry
  assert.deepEqual(await armory.character("jaina"), first);
  assert.equal(profileCalls(fake.calls), 9);
  // the 304 renewed freshness, so the next view within 4 minutes is free
  advance(3 * 60 * 1000);
  await armory.character("jaina");
  assert.equal(profileCalls(fake.calls), 9);
});

test("a character who played since is refetched in full", async () => {
  const routes = characterFixture();
  const { armory, fake, advance } = setup(routes);
  await armory.character("jaina");
  (routes[`${BASE}/jaina`] as { equipped_item_level: number }).equipped_item_level = 71;
  fake.state.lastModified = "Fri, 16 Oct 2026 12:00:00 GMT";
  advance(20 * 60 * 1000);
  assert.equal((await armory.character("jaina"))?.itemLevel, 71);
  assert.equal(profileCalls(fake.calls), 16);
  // and the new Last-Modified is what gets revalidated next
  advance(20 * 60 * 1000);
  await armory.character("jaina");
  assert.equal(profileCalls(fake.calls), 17);
});

test("unknown characters are rechecked with one call after 4 minutes", async () => {
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

test("a cached character is served when Blizzard is down; errors surface without a cache", async () => {
  const { armory, fake } = setup();
  fake.state.apiDown = true;
  await assert.rejects(armory.character("jaina"), /unreachable/);
});

// Forever: no realms. Characters are found through the guild roster's name-surname slugs.
const FOREVER = "/profile/wow/character/jaina-proudmoore";
function foreverFixture() {
  const routes: Record<string, unknown> = {
    "/data/wow/guild/old-school/roster": {
      members: [
        { character: { name: "Thrall", surname: "Durotan", slug: "thrall-durotan", level: 14, playable_class: { id: 7 } }, rank: 0 },
        { character: { name: "Jaina", surname: "Proudmoore", slug: "jaina-proudmoore", level: 12, playable_class: { id: 8 } }, rank: 3 },
        { character: { name: "Oddball", slug: "oddball-x", level: 2, playable_class: { id: 6 } }, rank: 9 },
      ],
    },
    [FOREVER]: { name: "Jaina", surname: "Proudmoore", level: 12, character_class: { id: 8 }, last_login_timestamp: 1 },
    [`${FOREVER}/professions`]: { primaries: [{ profession: { name: "Tailoring" } }], secondaries: [] },
    "/data/wow/search/media": iconSearch,
  };
  return routes;
}
const foreverCfg = { region: "us", namespace: "forever", guild: "old-school" };

test("roster maps classes, sorts by name, and leaves unknown classes null", async () => {
  const { armory } = setup(foreverFixture(), foreverCfg);
  assert.deepEqual(await armory.roster(), [
    { name: "Jaina", surname: "Proudmoore", slug: "jaina-proudmoore", level: 12, classId: "mage", rank: 3 },
    { name: "Oddball", surname: null, slug: "oddball-x", level: 2, classId: null, rank: 9 },
    { name: "Thrall", surname: "Durotan", slug: "thrall-durotan", level: 14, classId: "shaman", rank: 0 },
  ]);
});

test("realm flavours read the roster under the realm", async () => {
  const routes = characterFixture();
  routes["/data/wow/guild/doomhowl/fatal/roster"] = {
    members: [{ character: { name: "Jaina", level: 60, playable_class: { id: 8 } }, rank: 1 }],
  };
  const { armory } = setup(routes);
  assert.deepEqual(await armory.roster(), [{ name: "Jaina", surname: null, slug: null, level: 60, classId: "mage", rank: 1 }]);
});

test("forever resolves characters through the guild roster's slugs", async () => {
  const { armory, fake } = setup(foreverFixture(), foreverCfg);
  const c = await armory.character("JAINA");
  assert.equal(c?.name, "Jaina");
  assert.equal(c?.surname, "Proudmoore");
  assert.deepEqual(c?.professions, { primary: ["tailoring"], secondary: [], skills: {}, recipes: [] });
  assert.ok(fake.calls.includes(FOREVER));
});

// Forever lets characters share a first name; the surname tells them apart.
function sharedNameFixture() {
  const routes = foreverFixture();
  const roster = routes["/data/wow/guild/old-school/roster"] as { members: unknown[] };
  roster.members.push({ character: { name: "Jaina", surname: "Theramore", slug: "jaina-theramore", level: 30, playable_class: { id: 8 } }, rank: 4 });
  routes["/profile/wow/character/jaina-theramore"] = { name: "Jaina", surname: "Theramore", level: 30, character_class: { id: 8 }, last_login_timestamp: 1 };
  return routes;
}

test("forever: a shared first name is resolved by surname", async () => {
  const { armory, fake } = setup(sharedNameFixture(), foreverCfg);
  assert.equal((await armory.character("jaina", "PROUDMOORE"))?.level, 12);
  assert.equal((await armory.character("Jaina", "Theramore"))?.level, 30);
  assert.ok(fake.calls.includes(FOREVER));
  assert.ok(fake.calls.includes("/profile/wow/character/jaina-theramore"));
  assert.equal(await armory.character("Jaina", "Nobody"), null);
});

test("forever: a shared first name without a surname is ambiguous and costs no profile call", async () => {
  const { armory, fake } = setup(sharedNameFixture(), foreverCfg);
  assert.equal(await armory.character("jaina"), null);
  assert.deepEqual(fake.calls.filter((c) => c.startsWith("/profile")), []);
});

test("forever: names outside the guild are not found and cost no profile call", async () => {
  const { armory, fake } = setup(foreverFixture(), foreverCfg);
  assert.equal(await armory.character("nobody"), null);
  assert.deepEqual(fake.calls.filter((c) => c.startsWith("/profile")), []);
});

test("forever: the roster is cached for 4 minutes, and served stale when Blizzard is down", async () => {
  const { armory, fake, advance } = setup(foreverFixture(), foreverCfg);
  await armory.character("nobody");
  await armory.character("nobody");
  const rosterCalls = () => fake.calls.filter((c) => c.endsWith("/roster")).length;
  assert.equal(rosterCalls(), 1);
  advance(16 * 60 * 1000);
  await armory.character("nobody");
  assert.equal(rosterCalls(), 2);
  advance(16 * 60 * 1000);
  fake.state.apiDown = true;
  assert.equal(await armory.character("nobody"), null);
});

test("forever: concurrent lookups share one roster fetch", async () => {
  const { armory, fake } = setup(foreverFixture(), foreverCfg);
  await Promise.all([armory.character("nobody"), armory.character("thrall"), armory.character("x")]);
  assert.equal(fake.calls.filter((c) => c.endsWith("/roster")).length, 1);
});

test("forever: Legacy progress counts completed Legacy achievements, found by reward text", async () => {
  const routes = foreverFixture();
  Object.assign(routes, {
    "/data/wow/achievement-category/index": { categories: [{ id: 1 }, { id: 2 }] },
    "/data/wow/achievement-category/1": { achievements: [{ id: 100 }, { id: 101 }, { id: 200 }] },
    "/data/wow/achievement-category/2": { achievements: [{ id: 100 }, { id: 300 }] },
    // 100 and 101 are faction copies of one challenge; 200 is legacy too; 300 is not.
    "/data/wow/achievement/100": { id: 100, name: "Novice Mage", reward_description: "Earn 1 Legacy Point." },
    "/data/wow/achievement/101": { id: 101, name: "Novice Mage", reward_description: "Earn 1 Legacy Point." },
    "/data/wow/achievement/200": { id: 200, name: "Journeyman Tailor", reward_description: "Earn 1 Legacy Point." },
    "/data/wow/achievement/300": { id: 300, name: "Explore Durotar" },
    [`${FOREVER}/achievements`]: {
      achievements: [
        { id: 100, completed_timestamp: 1 },
        { id: 200 }, // in progress
        { id: 300, completed_timestamp: 1 }, // not a Legacy challenge
      ],
    },
  });
  const { armory, fake } = setup(routes, foreverCfg);
  assert.deepEqual((await armory.character("jaina"))?.legacy, { earned: 1, total: 2 });
  // definitions are cached: a second character costs no static calls
  const before = fake.calls.filter((c) => c.startsWith("/data/wow/achievement")).length;
  await armory.legacyAchievements();
  assert.equal(fake.calls.filter((c) => c.startsWith("/data/wow/achievement")).length, before);
});

test("forever: a failed Legacy lookup leaves legacy null but the character loads", async () => {
  const { armory } = setup(foreverFixture(), foreverCfg);
  const c = await armory.character("jaina");
  assert.equal(c?.name, "Jaina");
  assert.equal(c?.legacy, null);
});

test("Classic Era has no Legacy and spends no Legacy achievement calls", async () => {
  const { armory, fake } = setup();
  assert.equal((await armory.character("jaina"))?.legacy, null);
  assert.ok(!fake.calls.some((c) => c.includes("achievement") && !c.endsWith("/statistics")));
});

test("forever: an unknown guild surfaces as an error, and a new guild never sees old data", async () => {
  const { armory, cache } = setup(foreverFixture(), foreverCfg);
  await armory.character("jaina");
  const { armory: other } = setup(foreverFixture(), { ...foreverCfg, guild: "other" }, cache);
  await assert.rejects(other.character("jaina"), /guild not found/);
});

test("milestoneOf maps Master <Class>, Journeyman/Expert/Artisan <crafter> and Rank <N>; ignores the rest", () => {
  assert.deepEqual(milestoneOf("Master Druid"), { kind: "level", key: "60", classId: "druid" });
  assert.deepEqual(milestoneOf("Journeyman Alchemist"), { kind: "skill", key: "alchemy:150", classId: null });
  assert.deepEqual(milestoneOf("Expert Tailor"), { kind: "skill", key: "tailoring:225", classId: null });
  assert.deepEqual(milestoneOf("Artisan Leatherworker"), { kind: "skill", key: "leatherworking:300", classId: null });
  assert.deepEqual(milestoneOf("Rank 14"), { kind: "pvp_rank", key: "14", classId: null });
  for (const name of ["Master Spelunker", "Master of Alterac Valley", "Apprentice Tailor", "Expert Miner", "Grand Master Tailor", "Rank 15", "Novice Mage", "Journeyman constructor", "toString Tailor"]) {
    assert.equal(milestoneOf(name), null, name);
  }
});

test("forever: completed milestone achievements come back with their dates", async () => {
  const routes = foreverFixture();
  Object.assign(routes, {
    "/data/wow/achievement-category/index": { categories: [{ id: 1 }] },
    "/data/wow/achievement-category/1": { achievements: [{ id: 400 }, { id: 401 }, { id: 402 }, { id: 403 }] },
    "/data/wow/achievement/400": { id: 400, name: "Master Mage", reward_description: "Earn 1 Legacy Point." },
    "/data/wow/achievement/401": { id: 401, name: "Artisan Tailor", reward_description: "Earn 1 Legacy Point." },
    "/data/wow/achievement/402": { id: 402, name: "Rank 7", reward_description: "Earn 1 Legacy Point." },
    "/data/wow/achievement/403": { id: 403, name: "Master Spelunker", reward_description: "Earn 1 Legacy Point." },
    [`${FOREVER}/achievements`]: {
      achievements: [
        { id: 400, completed_timestamp: Date.UTC(2026, 9, 1) },
        { id: 401 }, // in progress
        { id: 402, completed_timestamp: Date.UTC(2026, 9, 2) },
        { id: 403, completed_timestamp: Date.UTC(2026, 9, 3) },
      ],
    },
  });
  const { armory } = setup(routes, foreverCfg);
  assert.deepEqual((await armory.character("jaina"))?.milestoneAchievements, [
    { kind: "level", key: "60", classId: "mage", completedAt: "2026-10-01T00:00:00.000Z" },
    { kind: "pvp_rank", key: "7", classId: null, completedAt: "2026-10-02T00:00:00.000Z" },
  ]);
});

test("milestone achievements are empty when the lookup fails or outside Forever", async () => {
  assert.deepEqual((await setup(foreverFixture(), foreverCfg).armory.character("jaina"))?.milestoneAchievements, []);
  assert.deepEqual((await setup().armory.character("jaina"))?.milestoneAchievements, []);
});

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
