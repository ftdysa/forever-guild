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
