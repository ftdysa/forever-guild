import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";

const PASS = "for-the-horde";
const config = { port: 0, dbPath: ":memory:", guildPassphrase: PASS, sessionSecret: "x".repeat(40), cookieSecure: false };

const thrall = {
  characterName: "Thrall",
  mainClass: "shaman",
  mainSpec: "restoration",
  backupClass: "warrior",
  backupSpec: "protection",
  primaryProfessions: ["alchemy", "herbalism"],
  secondaryProfessions: ["cooking"],
  sweatFactor: "casual",
  levelingPref: "duo",
  notes: "",
};

let app: FastifyInstance;
let cookie: { session: string };

before(async () => {
  app = buildApp(config);
  await app.ready();
  const res = await app.inject({ method: "POST", url: "/api/login", payload: { passphrase: PASS } });
  assert.equal(res.statusCode, 204);
  const c = res.cookies.find((x) => x.name === "session");
  assert.ok(c);
  cookie = { session: c.value };
});
after(async () => app.close());

test("game-data is public", async () => {
  const res = await app.inject({ method: "GET", url: "/api/game-data" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().classes.length, 9);
  assert.equal(res.json().sweatFactors.length, 5);
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
    ["POST", "/api/members"],
    ["PUT", "/api/members/1"],
    ["DELETE", "/api/members/1"],
    ["POST", "/api/logout"],
  ] as const) {
    const res = await app.inject({ method, url, payload: method === "GET" || method === "DELETE" ? undefined : thrall });
    assert.equal(res.statusCode, 401, `${method} ${url}`);
  }
  const forged = await app.inject({ method: "GET", url: "/api/members", cookies: { session: "forged.sig" } });
  assert.equal(forged.statusCode, 401);
});

test("create, list, update, delete", async () => {
  const created = await app.inject({ method: "POST", url: "/api/members", cookies: cookie, payload: thrall });
  assert.equal(created.statusCode, 201);
  const m = created.json();
  assert.equal(m.characterName, "Thrall");
  assert.equal(typeof m.id, "number");
  assert.equal(m.sweatFactor, "casual");
  assert.equal(m.levelingPref, "duo");

  const list = await app.inject({ method: "GET", url: "/api/members", cookies: cookie });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().length, 1);

  const updated = await app.inject({
    method: "PUT",
    url: `/api/members/${m.id}`,
    cookies: cookie,
    payload: { ...thrall, mainSpec: "elemental" },
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().mainSpec, "elemental");

  const del = await app.inject({ method: "DELETE", url: `/api/members/${m.id}`, cookies: cookie });
  assert.equal(del.statusCode, 204);
  const again = await app.inject({ method: "DELETE", url: `/api/members/${m.id}`, cookies: cookie });
  assert.equal(again.statusCode, 404);
});

test("validation errors are 400 with details", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/members",
    cookies: cookie,
    payload: { ...thrall, mainSpec: "protection" },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "validation failed");
  assert.ok(res.json().details.includes("mainSpec does not belong to mainClass"));
});

test("duplicate name is 409", async () => {
  const a = await app.inject({ method: "POST", url: "/api/members", cookies: cookie, payload: { ...thrall, characterName: "Jaina" } });
  assert.equal(a.statusCode, 201);
  const b = await app.inject({ method: "POST", url: "/api/members", cookies: cookie, payload: { ...thrall, characterName: "jaina" } });
  assert.equal(b.statusCode, 409);
  assert.deepEqual(b.json(), { error: "character name already taken" });
});

test("malformed JSON body is 400", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/members",
    cookies: cookie,
    headers: { "content-type": "application/json" },
    payload: "{bad json",
  });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.json(), { error: "bad request" });
});

test("unsupported media type is 415", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/members",
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
  const res = await app.inject({ method: "PUT", url: "/api/members/99999", cookies: cookie, payload: thrall });
  assert.equal(res.statusCode, 404);
  const bad = await app.inject({ method: "PUT", url: "/api/members/abc", cookies: cookie, payload: thrall });
  assert.equal(bad.statusCode, 400);
});

test("logout clears the cookie", async () => {
  const res = await app.inject({ method: "POST", url: "/api/logout", cookies: cookie });
  assert.equal(res.statusCode, 204);
  const c = res.cookies.find((x) => x.name === "session");
  assert.ok(c);
  assert.equal(c.value, "");
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
  let res;
  for (let i = 0; i < 11; i++) {
    res = await app2.inject({ method: "POST", url: "/api/login", payload: { passphrase: "wrong" } });
  }
  assert.equal(res!.statusCode, 429);
  await app2.close();
});
