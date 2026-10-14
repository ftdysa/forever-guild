import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

test("loads with defaults", () => {
  const c = loadConfig({ GUILD_PASSPHRASE: "pw", SESSION_SECRET: "s".repeat(32) });
  assert.equal(c.port, 3000);
  assert.equal(c.dbPath, "./data/roster.db");
  assert.equal(c.guildPassphrase, "pw");
  assert.equal(c.cookieSecure, false);
});

test("honours COOKIE_SECURE", () => {
  const c = loadConfig({ GUILD_PASSPHRASE: "pw", SESSION_SECRET: "s".repeat(32), COOKIE_SECURE: "true" });
  assert.equal(c.cookieSecure, true);
});

test("honours PORT and DB_PATH", () => {
  const c = loadConfig({ GUILD_PASSPHRASE: "pw", SESSION_SECRET: "s".repeat(32), PORT: "8080", DB_PATH: ":memory:" });
  assert.equal(c.port, 8080);
  assert.equal(c.dbPath, ":memory:");
});

test("throws listing missing vars", () => {
  assert.throws(() => loadConfig({}), /GUILD_PASSPHRASE, SESSION_SECRET/);
  assert.throws(() => loadConfig({ GUILD_PASSPHRASE: "pw" }), /SESSION_SECRET/);
});

test("rejects short SESSION_SECRET and bad PORT", () => {
  assert.throws(() => loadConfig({ GUILD_PASSPHRASE: "pw", SESSION_SECRET: "short" }), /SESSION_SECRET must be at least 32 characters/);
  assert.throws(() => loadConfig({ GUILD_PASSPHRASE: "pw", SESSION_SECRET: "s".repeat(32), PORT: "abc" }), /PORT must be a number/);
});
