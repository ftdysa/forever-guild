import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import { sessionCookieName } from "../src/routes/auth.js";
import type { FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PASS = "for-the-horde";
const config = { port: 0, dbPath: ":memory:", guildPassphrase: PASS, sessionSecret: "x".repeat(40), cookieSecure: false };

// Editable details for a synced member.
const details = { mainSpec: "restoration", backupClass: "warrior", backupSpec: "protection", altOf: null, levelingPref: "duo", notes: "" };

let app: FastifyInstance;
let cookie: Record<string, string>;

// Logs in and returns the session cookie, ready to pass as `cookies`.
async function login(a: FastifyInstance): Promise<Record<string, string>> {
  const res = await a.inject({ method: "POST", url: "/api/login", payload: { passphrase: PASS } });
  assert.equal(res.statusCode, 204);
  const name = sessionCookieName(a.config.cookieSecure);
  const c = res.cookies.find((x) => x.name === name);
  assert.ok(c);
  assert.equal(c.secure ?? false, a.config.cookieSecure);
  return { [name]: c.value };
}

async function failLogins(a: FastifyInstance, n: number, headers: (i: number) => Record<string, string> = () => ({})) {
  const codes: number[] = [];
  for (let i = 0; i < n; i++) {
    const res = await a.inject({ method: "POST", url: "/api/login", headers: headers(i), payload: { passphrase: "wrong" } });
    codes.push(res.statusCode);
  }
  return codes;
}

before(async () => {
  app = buildApp(config);
  await app.ready();
  cookie = await login(app);
});
after(async () => app.close());

test("game-data is public", async () => {
  const res = await app.inject({ method: "GET", url: "/api/game-data" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().classes.length, 9);
  assert.equal(res.json().sweatTiers.length, 6);
  assert.equal(res.json().levelingPrefs.length, 3);
});

test("index.html is served", async () => {
  const res = await app.inject({ method: "GET", url: "/" });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"] as string, /text\/html/);
});

test("wrong passphrase is 401 and no cookie", async () => {
  const res = await app.inject({ method: "POST", url: "/api/login", payload: { passphrase: "nope" } });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.json(), { error: "unauthorized" });
  assert.equal(res.cookies.length, 0);
});

test("missing passphrase is 400", async () => {
  const res = await app.inject({ method: "POST", url: "/api/login", payload: {} });
  assert.equal(res.statusCode, 400);
});

test("members routes require session", async () => {
  for (const [method, url] of [
    ["GET", "/api/members"],
    ["PUT", "/api/members/1"],
    ["POST", "/api/logout"],
  ] as const) {
    const res = await app.inject({ method, url, payload: method === "GET" ? undefined : details });
    assert.equal(res.statusCode, 401, `${method} ${url}`);
  }
  const forged = await app.inject({ method: "GET", url: "/api/members", cookies: { session: "forged.sig" } });
  assert.equal(forged.statusCode, 401);
});

test("members can be listed and their details edited, but not created or deleted", async () => {
  const [thrall] = app.store.syncRoster([{ name: "Thrall", surname: "Durotan", slug: "thrall-durotan", classId: "shaman", level: 14, rank: 0 }]);
  app.store.applyArmory(thrall, {
    spec: null,
    primary: [],
    secondary: [],
    armory: {
      race: null, gender: null, faction: null, title: null, itemLevel: null, lastLogin: null,
      achievementPoints: null, legacy: null, skills: {}, recipes: [2414], pvp: null, sweatStats: null,
    },
  });
  const list = await app.inject({ method: "GET", url: "/api/members", cookies: cookie });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.json().map((m: { characterName: string }) => m.characterName), ["Thrall"]);
  // recipe ids are for the crafting route only; the member list leaves them out
  assert.ok(list.json()[0].armory);
  assert.equal("recipes" in list.json()[0].armory, false);
  // Thrall alone: top level of a guild of one, no professions; other metrics unknown.
  assert.deepEqual(list.json()[0].sweat, {
    score: 63,
    tier: "drenched",
    mainId: thrall.id,
    main: "Thrall Durotan",
    breakdown: { leveling: 62.5, gear: 0, professions: 0, dungeons: 0, pvp: 0, reputation: 0, legacy: 0, questing: 0 },
  });

  const updated = await app.inject({ method: "PUT", url: `/api/members/${thrall.id}`, cookies: cookie, payload: details });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().mainSpec, "restoration");
  assert.equal(updated.json().altOf, null);
  assert.equal("recipes" in updated.json().armory, false);
  assert.equal(updated.json().sweat.score, 63);
  // synced fields are not editable
  const ignored = await app.inject({
    method: "PUT",
    url: `/api/members/${thrall.id}`,
    cookies: cookie,
    payload: { ...details, characterName: "Garrosh", mainClass: "warrior", level: 60 },
  });
  assert.equal(ignored.json().characterName, "Thrall");
  assert.equal(ignored.json().level, 14);

  assert.equal((await app.inject({ method: "POST", url: "/api/members", cookies: cookie, payload: details })).statusCode, 404);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/members/${thrall.id}`, cookies: cookie })).statusCode, 404);
});

test("validation errors are 400 with details, checked against the synced class", async () => {
  const id = app.store.list()[0].id;
  const res = await app.inject({ method: "PUT", url: `/api/members/${id}`, cookies: cookie, payload: { ...details, mainSpec: "fury" } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "validation failed");
  assert.ok(res.json().details.includes("mainSpec does not belong to the main class"));
});

test("altOf links an alt to its main and is checked against the roster", async () => {
  const thrallEntry = { name: "Thrall", surname: "Durotan", slug: "thrall-durotan", classId: "shaman", level: 14, rank: 0 };
  const [rexxar] = app.store.syncRoster([thrallEntry, { name: "Rexxar", surname: "Mok", slug: "rexxar-mok", classId: "hunter", level: 5, rank: 2 }]);
  const thrall = app.store.list().find((m) => m.characterName === "Thrall")!;
  // The shared details carry a shaman spec; Rexxar is a hunter.
  const put = (id: number, altOf: unknown) =>
    app.inject({
      method: "PUT",
      url: `/api/members/${id}`,
      cookies: cookie,
      payload: { ...details, mainSpec: id === rexxar.id ? "marksmanship" : details.mainSpec, altOf },
    });

  const linked = await put(rexxar.id, thrall.id);
  assert.equal(linked.statusCode, 200);
  assert.equal(linked.json().altOf, thrall.id);
  // Rexxar has no armory read yet, so he shows his main's score.
  assert.equal(linked.json().sweat.mainId, thrall.id);
  assert.equal(linked.json().sweat.main, "Thrall Durotan");

  const errorOf = async (id: number, altOf: unknown) => (await put(id, altOf)).json().details;
  assert.deepEqual(await errorOf(thrall.id, rexxar.id), ["altOf must point at a main, not another alt"]);
  assert.deepEqual(await errorOf(rexxar.id, rexxar.id), ["a member cannot be their own alt"]);
  assert.deepEqual(await errorOf(rexxar.id, 99999), ["altOf is not a guild member"]);
  assert.deepEqual(await errorOf(rexxar.id, "x"), ["altOf must be a member id or null"]);

  assert.equal((await put(rexxar.id, null)).json().altOf, null);
});

test("malformed JSON body is 400", async () => {
  const res = await app.inject({
    method: "PUT",
    url: "/api/members/1",
    cookies: cookie,
    headers: { "content-type": "application/json" },
    payload: "{bad json",
  });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.json(), { error: "bad request" });
});

test("unsupported media type is 415", async () => {
  const res = await app.inject({
    method: "PUT",
    url: "/api/members/1",
    cookies: cookie,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: "a=b",
  });
  assert.equal(res.statusCode, 415);
  assert.deepEqual(res.json(), { error: "unsupported media type" });
});

test("unknown route is 404 with error body", async () => {
  const res = await app.inject({ method: "GET", url: "/api/nope", cookies: cookie });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.json(), { error: "not found" });
});

test("unknown id is 404, bad id is 400", async () => {
  const res = await app.inject({ method: "PUT", url: "/api/members/99999", cookies: cookie, payload: details });
  assert.equal(res.statusCode, 404);
  const bad = await app.inject({ method: "PUT", url: "/api/members/abc", cookies: cookie, payload: details });
  assert.equal(bad.statusCode, 400);
});

test("logout clears the cookie", async () => {
  const res = await app.inject({ method: "POST", url: "/api/logout", cookies: cookie });
  assert.equal(res.statusCode, 204);
  const c = res.cookies.find((x) => x.name === "session");
  assert.ok(c);
  assert.equal(c.value, "");
  const reused = await app.inject({ method: "GET", url: "/api/members", cookies: cookie });
  assert.equal(reused.statusCode, 401, "logged-out session must be revoked server-side");
});

test("style.css and app.js are served", async () => {
  const css = await app.inject({ method: "GET", url: "/style.css" });
  assert.equal(css.statusCode, 200);
  assert.match(css.headers["content-type"] as string, /text\/css/);
  const js = await app.inject({ method: "GET", url: "/app.js" });
  assert.equal(js.statusCode, 200);
  assert.match(js.body, /api\/game-data/);
});

test("login is rate-limited after repeated failures", async () => {
  const app2 = buildApp(config);
  await app2.ready();
  assert.equal((await failLogins(app2, 11)).at(-1), 429);
  await app2.close();
});

test("spoofed X-Forwarded-For does not bypass the login rate limit behind a proxy", async () => {
  const a = buildApp({ ...config, trustProxy: true });
  await a.ready();
  const codes = await failLogins(a, 11, (i) => ({ "x-forwarded-for": `10.0.0.${i}, 203.0.113.7` }));
  assert.equal(codes.at(-1), 429);
  await a.close();
});

test("rate limit keys on CLIENT_IP_HEADER when configured", async () => {
  const a = buildApp({ ...config, clientIpHeader: "fly-client-ip" });
  await a.ready();
  const same = await failLogins(a, 11, (i) => ({ "fly-client-ip": "203.0.113.7", "x-forwarded-for": `10.0.0.${i}` }));
  assert.equal(same.at(-1), 429);
  const other = await failLogins(a, 1, () => ({ "fly-client-ip": "203.0.113.8" }));
  assert.equal(other[0], 401);
  await a.close();
});

test("changing the passphrase revokes existing sessions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roster-"));
  const fileConfig = { ...config, dbPath: join(dir, "roster.db") };
  try {
    const a = buildApp(fileConfig);
    const session = await login(a);
    await a.close();

    const same = buildApp(fileConfig);
    assert.equal((await same.inject({ method: "GET", url: "/api/members", cookies: session })).statusCode, 200);
    await same.close();

    const changed = buildApp({ ...fileConfig, guildPassphrase: "a-brand-new-passphrase" });
    assert.equal((await changed.inject({ method: "GET", url: "/api/members", cookies: session })).statusCode, 401);
    await changed.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("secure mode uses a __Host- cookie", async () => {
  const a = buildApp({ ...config, cookieSecure: true });
  const session = await login(a);
  assert.deepEqual(Object.keys(session), ["__Host-session"]);
  const members = await a.inject({ method: "GET", url: "/api/members", cookies: session });
  assert.equal(members.statusCode, 200);
  await a.close();
});

test("security headers are set", async () => {
  const res = await app.inject({ method: "GET", url: "/" });
  const csp = res.headers["content-security-policy"] as string;
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.equal(res.headers["x-content-type-options"], "nosniff");
});
