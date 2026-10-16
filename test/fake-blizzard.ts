import type { FetchFn } from "../src/blizzard.js";

type Handler = (url: URL) => unknown;

// In-memory stand-in for oauth.battle.net + the Profile API. Responses keyed by URL path;
// a function value computes the response from the full URL (e.g. search queries).
export function fakeBlizzard(routes: Record<string, unknown | { status: number } | Handler> = {}) {
  const calls: string[] = [];
  let tokenCount = 0;
  const state = { tokenStatus: 200, apiDown: false, expiresIn: 86_400 };

  const fetchFn: FetchFn = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.hostname === "oauth.battle.net") {
      if (state.tokenStatus !== 200) return new Response("{}", { status: state.tokenStatus });
      tokenCount++;
      return Response.json({ access_token: `tok-${tokenCount}`, expires_in: state.expiresIn });
    }
    if (state.apiDown) throw new TypeError("fetch failed");
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== `Bearer tok-${tokenCount}`) return new Response("{}", { status: 401 });
    const entry = routes[url.pathname];
    const route = typeof entry === "function" ? (entry as Handler)(url) : entry;
    if (route === undefined) return new Response("{}", { status: 404 });
    if (typeof route === "object" && route !== null && "status" in route) {
      return new Response("{}", { status: (route as { status: number }).status });
    }
    return Response.json(route);
  };

  return { fetchFn, calls, state, tokens: () => tokenCount };
}

export const BASE = "/profile/wow/character/doomhowl";

// A level-60 Frost mage with full data, plus a guild roster that includes her.
export function guildFixture() {
  return {
    "/data/wow/guild/doomhowl/fatal/roster": {
      members: [
        { character: { name: "Zuljin", level: 42, playable_class: { id: 3 } }, rank: 4 },
        { character: { name: "Jaina", level: 60, playable_class: { id: 8 } }, rank: 1 },
        { character: { name: "Oddball", level: 10, playable_class: { id: 6 } }, rank: 7 },
      ],
    },
    [`${BASE}/jaina`]: {
      name: "Jaina",
      level: 60,
      faction: { type: "ALLIANCE" },
      character_class: { id: 8 },
      race: { name: "Human" },
      guild: { name: "Fatal" },
      equipped_item_level: 66,
      last_login_timestamp: Date.UTC(2026, 9, 1),
    },
    [`${BASE}/jaina/equipment`]: {
      equipped_items: [
        {
          slot: { type: "HEAD", name: "Head" },
          name: "Frostfire Circlet",
          quality: { type: "EPIC" },
          item: { id: 22498 },
          binding: { name: "Binds when picked up" },
          inventory_type: { name: "Head" },
          item_subclass: { name: "Cloth" },
          armor: { display: { display_string: "98 Armor" } },
          stats: [{ display: { display_string: "+23 Stamina" } }, { display: { display_string: "+27 Intellect" } }],
          enchantments: [{ display_string: "Enchanted: +8 Intellect" }],
          spells: [{ description: "Equip: Increases damage and healing done by magical spells and effects by up to 35." }],
          set: {
            item_set: { name: "Frostfire Regalia" },
            display_string: "Frostfire Regalia (2/9)",
            items: [
              { item: { name: "Frostfire Circlet" }, is_equipped: true },
              { item: { name: "Frostfire Robe" }, is_equipped: true },
              { item: { name: "Frostfire Sandals" } },
            ],
            effects: [
              { display_string: "(2) Set: Your Arcane Missiles refund 10% of their mana cost.", required_count: 2 },
              { display_string: "(4) Set: Chance on spell cast to gain 200 mana.", required_count: 4 },
            ],
          },
          durability: { display_string: "Durability 60 / 60" },
          requirements: { level: { display_string: "Requires Level 60" } },
        },
        {
          slot: { type: "MAIN_HAND", name: "Main Hand" },
          name: "Atiesh, Greatstaff of the Guardian",
          quality: { type: "LEGENDARY" },
          item: { id: 22589 },
          unique_equipped: "Unique",
          inventory_type: { name: "Two-Hand" },
          item_subclass: { name: "Staff" },
          weapon: {
            damage: { display_string: "124 - 207 Damage" },
            attack_speed: { display_string: "Speed 2.90" },
            dps: { display_string: "(57.1 damage per second)" },
          },
          description: "Guardian of the Tirisfal.",
        },
        { slot: { type: "SHIRT", name: "Shirt" }, name: "White Shirt", quality: { type: "COMMON" }, item: { id: 45 }, is_subclass_hidden: true, item_subclass: { name: "Miscellaneous" } },
      ],
    },
    [`${BASE}/jaina/specializations`]: {
      specialization_groups: [
        { is_active: true, specializations: [
          { specialization_name: "Frost", spent_points: 40 },
          { specialization_name: "Arcane", spent_points: 11 },
        ] },
      ],
    },
    [`${BASE}/jaina/character-media`]: {
      assets: [
        { key: "avatar", value: "https://render.worldofwarcraft.com/classic1x-us/character/doomhowl/1/2-avatar.jpg" },
        { key: "main-raw", value: "https://render.worldofwarcraft.com/classic1x-us/character/doomhowl/1/2-main-raw.png" },
      ],
    },
    [`${BASE}/jaina/statistics`]: {
      health: 4200,
      power: 6100,
      power_type: { name: "Mana" },
      strength: { base: 20, effective: 35 },
      agility: { base: 30, effective: 40 },
      stamina: { base: 60, effective: 210 },
      intellect: { base: 120, effective: 290 },
      spirit: { base: 110, effective: 150 },
      melee_crit: { value: 5.1 },
      ranged_crit: { value: 4.2 },
      spell_crit: { value: 9.256 },
    },
    // Media search (static namespace): `id=a||b||c` returns the icons it knows; the shirt has none.
    "/data/wow/search/media": iconSearch,
  };
}

export const ICONS: Record<number, string> = {
  22498: "https://render.worldofwarcraft.com/classic1x-us/icons/56/inv_crown_01.jpg",
  22589: "https://evil.example/icon.jpg",
};

export function iconSearch(url: URL) {
  const ids = (url.searchParams.get("id") ?? "").split("||").map(Number);
  return {
    results: ids
      .filter((id) => ICONS[id])
      .map((id) => ({ data: { id, assets: [{ key: "icon", value: ICONS[id] }] } })),
  };
}
