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
