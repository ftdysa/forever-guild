import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { sessionCookieName } from "../src/routes/auth.js";
import type { FetchFn } from "../src/blizzard.js";

const PASS = "for-the-horde-forever";
const base = { port: 0, dbPath: ":memory:", guildPassphrase: PASS, sessionSecret: "x".repeat(40), cookieSecure: false };
const discord = { webhookUrl: "https://discord.com/api/webhooks/1/abc", siteUrl: "https://example.test" };

const member = (characterName: string) => ({
  characterName,
  mainClass: "shaman",
  mainSpec: "enhancement",
  backupClass: null,
  backupSpec: null,
  primaryProfessions: ["alchemy", "herbalism"],
  secondaryProfessions: [],
  sweatFactor: null,
  levelingPref: null,
  notes: "",
});

let calls: { url: string; body: { embeds: { title: string }[] } }[] = [];
let fail = false;
const fetchFn = (async (url: string, init: RequestInit) => {
  calls.push({ url, body: JSON.parse(String(init.body)) });
  if (fail) throw new Error("discord down");
  return new Response(null, { status: 204 });
}) as unknown as FetchFn;

async function login(a: FastifyInstance) {
  const res = await a.inject({ method: "POST", url: "/api/login", payload: { passphrase: PASS } });
  const name = sessionCookieName(false);
  return { [name]: res.cookies.find((c) => c.name === name)!.value };
}

let app: FastifyInstance;
let cookies: Record<string, string>;

before(async () => {
  app = buildApp({ ...base, discord }, { discordFetch: fetchFn });
  await app.ready();
  cookies = await login(app);
});
after(async () => app.close());
beforeEach(() => {
  calls = [];
  fail = false;
});

test("creating a member posts one join announcement", async () => {
  const res = await app.inject({ method: "POST", url: "/api/members", cookies, payload: member("Thrall") });
  assert.equal(res.statusCode, 201);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, discord.webhookUrl);
  assert.equal(calls[0].body.embeds[0].title, "Thrall joined the roster");
});

test("updates, deletes, and rejected creates do not post", async () => {
  const created = await app.inject({ method: "POST", url: "/api/members", cookies, payload: member("Jaina") });
  const id = created.json().id;
  calls = [];
  const put = await app.inject({ method: "PUT", url: `/api/members/${id}`, cookies, payload: { ...member("Jaina"), notes: "hi" } });
  assert.equal(put.statusCode, 200);
  const dup = await app.inject({ method: "POST", url: "/api/members", cookies, payload: member("Jaina") });
  assert.equal(dup.statusCode, 409);
  const del = await app.inject({ method: "DELETE", url: `/api/members/${id}`, cookies });
  assert.equal(del.statusCode, 204);
  assert.equal(calls.length, 0);
});

test("a failing webhook still returns 201", async () => {
  fail = true;
  const res = await app.inject({ method: "POST", url: "/api/members", cookies, payload: member("Rexxar") });
  assert.equal(res.statusCode, 201);
  assert.equal(calls.length, 1);
});

test("no webhook configured means no posts", async () => {
  const plain = buildApp(base, { discordFetch: fetchFn });
  await plain.ready();
  try {
    assert.equal(plain.notifier, null);
    const res = await plain.inject({ method: "POST", url: "/api/members", cookies: await login(plain), payload: member("Sylvanas") });
    assert.equal(res.statusCode, 201);
    assert.equal(calls.length, 0);
  } finally {
    await plain.close();
  }
});
