import type { FetchFn } from "../src/blizzard.js";

// In-memory stand-in for oauth.battle.net + the Profile API. Responses keyed by URL path.
export function fakeBlizzard(routes: Record<string, unknown | { status: number }> = {}) {
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
    const route = routes[url.pathname];
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
      character_class: { id: 8 },
      race: { name: "Human" },
      guild: { name: "Fatal" },
      equipped_item_level: 66,
      last_login_timestamp: Date.UTC(2026, 9, 1),
    },
    [`${BASE}/jaina/equipment`]: {
      equipped_items: [
        { slot: { name: "Head" }, name: "Frostfire Circlet", quality: { type: "EPIC" }, item: { id: 22498 } },
        { slot: { name: "Shirt" }, name: "White Shirt", quality: { type: "COMMON" }, item: { id: 45 } },
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
      assets: [{ key: "avatar", value: "https://render.worldofwarcraft.com/classic1x-us/character/doomhowl/1/2-avatar.jpg" }],
    },
  };
}
