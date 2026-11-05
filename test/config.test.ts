import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

const PW = "a-long-guild-passphrase";

test("loads with defaults", () => {
  const c = loadConfig({ GUILD_PASSPHRASE: PW, SESSION_SECRET: "s".repeat(32) });
  assert.equal(c.port, 3000);
  assert.equal(c.dbPath, "./data/roster.db");
  assert.equal(c.guildPassphrase, PW);
  assert.equal(c.clientIpHeader, undefined);
  assert.equal(c.trustProxy, false);
  assert.equal(c.cookieSecure, false);
});

test("honours COOKIE_SECURE", () => {
  const c = loadConfig({ GUILD_PASSPHRASE: PW, SESSION_SECRET: "s".repeat(32), COOKIE_SECURE: "true" });
  assert.equal(c.cookieSecure, true);
});

test("honours PORT and DB_PATH", () => {
  const c = loadConfig({ GUILD_PASSPHRASE: PW, SESSION_SECRET: "s".repeat(32), PORT: "8080", DB_PATH: ":memory:" });
  assert.equal(c.port, 8080);
  assert.equal(c.dbPath, ":memory:");
});

test("throws listing missing vars", () => {
  assert.throws(() => loadConfig({}), /GUILD_PASSPHRASE, SESSION_SECRET/);
  assert.throws(() => loadConfig({ GUILD_PASSPHRASE: PW }), /SESSION_SECRET/);
});

test("rejects short SESSION_SECRET and bad PORT", () => {
  assert.throws(() => loadConfig({ GUILD_PASSPHRASE: PW, SESSION_SECRET: "short" }), /SESSION_SECRET must be at least 32 characters/);
  assert.throws(() => loadConfig({ GUILD_PASSPHRASE: PW, SESSION_SECRET: "s".repeat(32), PORT: "abc" }), /PORT must be a number/);
});

test("rejects short GUILD_PASSPHRASE", () => {
  assert.throws(() => loadConfig({ GUILD_PASSPHRASE: "change-me", SESSION_SECRET: "s".repeat(32) }), /GUILD_PASSPHRASE must be at least 16 characters/);
});

test("honours CLIENT_IP_HEADER, lowercased", () => {
  const c = loadConfig({ GUILD_PASSPHRASE: PW, SESSION_SECRET: "s".repeat(32), CLIENT_IP_HEADER: "Fly-Client-IP" });
  assert.equal(c.clientIpHeader, "fly-client-ip");
});

const BZ = { BLIZZARD_CLIENT_ID: "id", BLIZZARD_CLIENT_SECRET: "secret", BLIZZARD_REALM: "doomhowl", BLIZZARD_GUILD: "fatal" };

test("blizzard config is optional and defaults to us / classic1x", () => {
  assert.equal(loadConfig({ GUILD_PASSPHRASE: PW, SESSION_SECRET: "s".repeat(32) }).blizzard, undefined);
  const c = loadConfig({ GUILD_PASSPHRASE: PW, SESSION_SECRET: "s".repeat(32), ...BZ });
  assert.deepEqual(c.blizzard, { clientId: "id", clientSecret: "secret", region: "us", namespace: "classic1x", realm: "doomhowl", guild: "fatal" });
});

test("blizzard config rejects partial setup, bad region/namespace, and non-slug names", () => {
  const env = { GUILD_PASSPHRASE: PW, SESSION_SECRET: "s".repeat(32) };
  assert.throws(() => loadConfig({ ...env, BLIZZARD_CLIENT_ID: "id" }), /also set: BLIZZARD_CLIENT_SECRET, BLIZZARD_REALM, BLIZZARD_GUILD/);
  assert.throws(() => loadConfig({ ...env, ...BZ, BLIZZARD_REGION: "cn" }), /BLIZZARD_REGION/);
  assert.throws(() => loadConfig({ ...env, ...BZ, BLIZZARD_NAMESPACE: "wotlk" }), /BLIZZARD_NAMESPACE/);
  assert.throws(() => loadConfig({ ...env, ...BZ, BLIZZARD_REALM: "Doom Howl" }), /slugs/);
  assert.throws(() => loadConfig({ ...env, ...BZ, BLIZZARD_GUILD: "../x" }), /slugs/);
});

test("forever needs no realm and rejects one", () => {
  const env = { ...BASE, BLIZZARD_NAMESPACE: "forever" };
  const fz = { ...BZ, BLIZZARD_REALM: "", BLIZZARD_GUILD: "old-school" };
  assert.deepEqual(loadConfig({ ...env, ...fz }).blizzard, {
    clientId: "id",
    clientSecret: "secret",
    region: "us",
    namespace: "forever",
    realm: undefined,
    guild: "old-school",
  });
  assert.throws(() => loadConfig({ ...env, BLIZZARD_CLIENT_ID: "id" }), /also set: BLIZZARD_CLIENT_SECRET, BLIZZARD_GUILD$/);
  assert.throws(() => loadConfig({ ...env, ...fz, BLIZZARD_REALM: "doomhowl" }), /BLIZZARD_REALM must be empty/);
});

const BASE = { GUILD_PASSPHRASE: PW, SESSION_SECRET: "s".repeat(32) };
const HOOK = "https://discord.com/api/webhooks/123456/abc-DEF_789";

test("discord is off without a webhook", () => {
  assert.equal(loadConfig(BASE).discord, undefined);
  assert.equal(loadConfig({ ...BASE, SITE_URL: "https://example.test" }).discord, undefined);
});

test("loads the discord webhook and site url", () => {
  assert.deepEqual(loadConfig({ ...BASE, DISCORD_WEBHOOK_URL: HOOK }).discord, { webhookUrl: HOOK, siteUrl: undefined });
  const legacy = "https://discordapp.com/api/webhooks/1/x";
  assert.equal(loadConfig({ ...BASE, DISCORD_WEBHOOK_URL: legacy }).discord?.webhookUrl, legacy);
  const c = loadConfig({ ...BASE, DISCORD_WEBHOOK_URL: HOOK, SITE_URL: "https://example.test" });
  assert.equal(c.discord?.siteUrl, "https://example.test");
});

test("rejects non-discord webhook urls without echoing them", () => {
  for (const bad of ["http://discord.com/api/webhooks/1/x", "https://evil.test/api/webhooks/1/x", "https://discord.com/api/webhooks/"]) {
    assert.throws(
      () => loadConfig({ ...BASE, DISCORD_WEBHOOK_URL: bad }),
      (err: Error) => /DISCORD_WEBHOOK_URL must be a Discord webhook URL/.test(err.message) && !err.message.includes(bad),
    );
  }
});

test("rejects a bad SITE_URL", () => {
  assert.throws(() => loadConfig({ ...BASE, DISCORD_WEBHOOK_URL: HOOK, SITE_URL: "example.test" }), /SITE_URL must be an http\(s\) URL/);
});
