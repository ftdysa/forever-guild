import { test } from "node:test";
import assert from "node:assert/strict";
import { BlizzardClient, BlizzardError, type FetchFn } from "../src/blizzard.js";
import { fakeBlizzard } from "./fake-blizzard.js";

const creds = { clientId: "id", clientSecret: "shh", region: "us", namespace: "classic1x" };

test("builds the profile namespace per game flavor", () => {
  assert.equal(new BlizzardClient(creds).profileNamespace, "profile-classic1x-us");
  assert.equal(new BlizzardClient({ ...creds, namespace: "classic", region: "eu" }).profileNamespace, "profile-classic-eu");
  assert.equal(new BlizzardClient({ ...creds, namespace: "retail" }).profileNamespace, "profile-us");
});

test("sends basic auth to oauth and the namespace to the api", async () => {
  const seen: { url: string; auth: string | null; body?: unknown }[] = [];
  const fetchFn: FetchFn = async (input, init) => {
    seen.push({ url: String(input), auth: new Headers(init?.headers).get("authorization"), body: init?.body });
    return String(input).startsWith("https://oauth.battle.net")
      ? Response.json({ access_token: "t1", expires_in: 3600 })
      : Response.json({ ok: true });
  };
  assert.deepEqual(await new BlizzardClient(creds, fetchFn).profile("/x"), { ok: true });
  assert.equal(seen[0].auth, `Basic ${Buffer.from("id:shh").toString("base64")}`);
  assert.equal(seen[0].body, "grant_type=client_credentials");
  assert.equal(seen[1].url, "https://us.api.blizzard.com/x?namespace=profile-classic1x-us&locale=en_US");
  assert.equal(seen[1].auth, "Bearer t1");
});

test("caches the token until shortly before expiry", async () => {
  let t = 0;
  const fake = fakeBlizzard({ "/a": { n: 1 } });
  fake.state.expiresIn = 3600;
  const client = new BlizzardClient(creds, fake.fetchFn, () => t);
  await client.profile("/a");
  await client.profile("/a");
  assert.equal(fake.tokens(), 1);
  t = 3600 * 1000 - 30_000; // inside the refresh margin
  await client.profile("/a");
  assert.equal(fake.tokens(), 2);
});

test("concurrent first requests share one token fetch", async () => {
  const fake = fakeBlizzard({ "/a": {} });
  const client = new BlizzardClient(creds, fake.fetchFn);
  await Promise.all([client.profile("/a"), client.profile("/a"), client.profile("/a")]);
  assert.equal(fake.tokens(), 1);
});

test("404 resolves null; other errors throw BlizzardError without leaking secrets", async () => {
  const fake = fakeBlizzard({ "/boom": { status: 503 } });
  const client = new BlizzardClient(creds, fake.fetchFn);
  assert.equal(await client.profile("/missing"), null);
  await assert.rejects(client.profile("/boom"), (e: unknown) => e instanceof BlizzardError && !/shh|tok-/.test(String(e)));
});

test("network failures and oauth failures become BlizzardError", async () => {
  const down = fakeBlizzard();
  down.state.apiDown = true;
  await assert.rejects(new BlizzardClient(creds, down.fetchFn).profile("/a"), BlizzardError);

  const badCreds = fakeBlizzard();
  badCreds.state.tokenStatus = 401;
  await assert.rejects(new BlizzardClient(creds, badCreds.fetchFn).profile("/a"), /oauth returned 401/);
});

test("a 401 from the api refreshes the token and retries once", async () => {
  let apiCalls = 0;
  let tokens = 0;
  const fetchFn: FetchFn = async (input, init) => {
    if (String(input).startsWith("https://oauth.battle.net")) return Response.json({ access_token: `t${++tokens}`, expires_in: 3600 });
    apiCalls++;
    return new Headers(init?.headers).get("authorization") === "Bearer t2" ? Response.json({ ok: 1 }) : new Response("", { status: 401 });
  };
  assert.deepEqual(await new BlizzardClient(creds, fetchFn).profile("/a"), { ok: 1 });
  assert.equal(apiCalls, 2);
  assert.equal(tokens, 2);
});

test("profileIfModified sends If-Modified-Since and maps 304 / 200 / 404", async () => {
  const fake = fakeBlizzard({ "/c": { name: "Jaina" } });
  const client = new BlizzardClient(creds, fake.fetchFn);
  const first = await client.profileIfModified<{ name: string }>("/c", null);
  assert.deepEqual(first, { modified: true, body: { name: "Jaina" }, lastModified: fake.state.lastModified });
  assert.deepEqual(await client.profileIfModified("/c", fake.state.lastModified), { modified: false });
  assert.deepEqual(await client.profileIfModified("/c", "Thu, 01 Jan 2026 00:00:00 GMT"), {
    modified: true,
    body: { name: "Jaina" },
    lastModified: fake.state.lastModified,
  });
  assert.deepEqual(await client.profileIfModified("/missing", null), { modified: true, body: null, lastModified: null });
});
