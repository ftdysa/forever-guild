import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { sessionCookieName } from "../src/routes/auth.js";
import { fakeBlizzard, guildFixture } from "./fake-blizzard.js";

const PASS = "for-the-horde-forever";
const base = { port: 0, dbPath: ":memory:", guildPassphrase: PASS, sessionSecret: "x".repeat(40), cookieSecure: false };
const blizzard = { clientId: "id", clientSecret: "shh", region: "us", namespace: "classic1x", realm: "doomhowl", guild: "fatal" };

const fake = fakeBlizzard(guildFixture());
let app: FastifyInstance;
let cookies: Record<string, string>;

async function login(a: FastifyInstance) {
  const res = await a.inject({ method: "POST", url: "/api/login", payload: { passphrase: PASS } });
  const name = sessionCookieName(false);
  return { [name]: res.cookies.find((c) => c.name === name)!.value };
}

before(async () => {
  app = buildApp({ ...base, blizzard }, { blizzardFetch: fake.fetchFn });
  await app.ready();
  cookies = await login(app);
});
after(async () => app.close());

test("armory routes require a session", async () => {
  for (const url of ["/api/armory/status", "/api/armory/roster", "/api/armory/character/jaina"]) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 401, url);
  }
});

test("status reports the configured guild without secrets", async () => {
  const res = await app.inject({ method: "GET", url: "/api/armory/status", cookies });
  assert.deepEqual(res.json(), {
    enabled: true,
    region: "us",
    namespace: "classic1x",
    realm: "doomhowl",
    guild: "fatal",
    wowheadItemUrl: "https://www.wowhead.com/classic/item=",
  });
  assert.doesNotMatch(res.body, /shh/);
});

test("roster flags members already in the ledger", async () => {
  const created = await app.inject({
    method: "POST",
    url: "/api/members",
    cookies,
    payload: { characterName: "jaina", mainClass: "mage", mainSpec: "frost", primaryProfessions: ["tailoring", "enchanting"] },
  });
  assert.equal(created.statusCode, 201);
  const res = await app.inject({ method: "GET", url: "/api/armory/roster", cookies });
  assert.equal(res.statusCode, 200);
  const byName = Object.fromEntries(res.json().map((r: { name: string; onRoster: boolean }) => [r.name, r.onRoster]));
  assert.deepEqual(byName, { Jaina: true, Oddball: false, Zuljin: false });
});

test("character lookup: found, not found, and invalid names never reach Blizzard", async () => {
  const ok = await app.inject({ method: "GET", url: "/api/armory/character/Jaina", cookies });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().spec.specId, "frost");

  const missing = await app.inject({ method: "GET", url: "/api/armory/character/Nobody", cookies });
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.json(), { error: "character not found" });

  const before = fake.calls.length;
  for (const bad of ["a", "..%2F..%2Fdata", "jaina%3Fnamespace%3Dx", "x".repeat(25)]) {
    const res = await app.inject({ method: "GET", url: `/api/armory/character/${bad}`, cookies });
    assert.equal(res.statusCode, 400, bad);
  }
  assert.equal(fake.calls.length, before);
});

test("upstream failure is 502 with a generic error", async () => {
  fake.state.apiDown = true;
  try {
    const res = await app.inject({ method: "GET", url: "/api/armory/character/Thrall", cookies });
    assert.equal(res.statusCode, 502);
    assert.deepEqual(res.json(), { error: "armory unavailable" });
  } finally {
    fake.state.apiDown = false;
  }
});

test("without Blizzard config the armory is disabled", async () => {
  const plain = buildApp(base);
  await plain.ready();
  const c = await login(plain);
  assert.deepEqual((await plain.inject({ method: "GET", url: "/api/armory/status", cookies: c })).json(), { enabled: false });
  assert.equal((await plain.inject({ method: "GET", url: "/api/armory/roster", cookies: c })).statusCode, 404);
  await plain.close();
});

test("CSP allows avatars from Blizzard's render host only", async () => {
  const res = await app.inject({ method: "GET", url: "/" });
  assert.match(res.headers["content-security-policy"] as string, /img-src 'self' data: https:\/\/render\.worldofwarcraft\.com/);
});
