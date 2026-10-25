import { test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyBaseLogger } from "fastify";
import type { FetchFn } from "../src/blizzard.js";
import type { Member } from "../src/db.js";
import { buildJoinEmbed, DiscordNotifier } from "../src/discord.js";

const thrall: Member = {
  id: 1,
  characterName: "Thrall",
  mainClass: "shaman",
  mainSpec: "enhancement",
  backupClass: "warrior",
  backupSpec: "protection",
  primaryProfessions: ["alchemy", "herbalism"],
  secondaryProfessions: ["first-aid"],
  sweatFactor: "casual",
  levelingPref: "duo",
  notes: "secret plans",
  createdAt: "2026-10-25T12:00:00.000Z",
  updatedAt: "2026-10-25T12:00:00.000Z",
};

const bare: Member = {
  ...thrall,
  characterName: "Anduin",
  mainClass: "priest",
  mainSpec: "holy",
  backupClass: null,
  backupSpec: null,
  primaryProfessions: [],
  secondaryProfessions: [],
  sweatFactor: null,
  levelingPref: null,
};

test("join embed has title, class colour, and named fields", () => {
  const e = buildJoinEmbed(thrall, "https://example.test");
  assert.equal(e.title, "Thrall joined the roster");
  assert.equal(e.url, "https://example.test");
  assert.equal(e.color, 0x0070dd);
  assert.equal(e.timestamp, thrall.createdAt);
  assert.deepEqual(
    e.fields.map((f) => [f.name, f.value]),
    [
      ["Main", "Shaman — Enhancement"],
      ["Backup", "Warrior — Protection"],
      ["Professions", "Alchemy, Herbalism, First Aid"],
      ["Style", "Casual · Duo"],
    ],
  );
});

test("join embed omits empty fields, url, and notes", () => {
  const e = buildJoinEmbed(bare);
  assert.equal("url" in e, false);
  assert.deepEqual(e.fields.map((f) => f.name), ["Main"]);
  assert.equal(JSON.stringify(buildJoinEmbed(thrall)).includes("secret plans"), false);
});

test("priest white is swapped for a visible grey", () => {
  assert.equal(buildJoinEmbed(bare).color, 0xc0c0c0);
});

const HOOK = "https://discord.com/api/webhooks/1/abc";

function fakeLog() {
  const warnings: unknown[][] = [];
  const log = { warn: (...args: unknown[]) => warnings.push(args) } as unknown as FastifyBaseLogger;
  return { log, warnings };
}

test("notifier posts the embed with mentions disabled", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(null, { status: 204 });
  }) as unknown as FetchFn;
  const { log, warnings } = fakeLog();
  await new DiscordNotifier({ webhookUrl: HOOK, siteUrl: "https://example.test" }, log, fetchFn).memberJoined(thrall);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, HOOK);
  assert.equal(calls[0].init.method, "POST");
  const body = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(body.allowed_mentions, { parse: [] });
  assert.deepEqual(body.embeds, [buildJoinEmbed(thrall, "https://example.test")]);
  assert.equal(warnings.length, 0);
});

test("notifier swallows non-2xx and network errors without logging the url", async () => {
  for (const [fetchFn, expectedPayload] of [
    [(async () => new Response("slow down", { status: 429 })) as unknown as FetchFn, { status: 429 }],
    [(async () => {
      throw new Error("boom");
    }) as unknown as FetchFn, { error: "boom" }],
  ]) {
    const { log, warnings } = fakeLog();
    await new DiscordNotifier({ webhookUrl: HOOK }, log, fetchFn).memberJoined(thrall);
    assert.equal(warnings.length, 1);
    assert.deepEqual(warnings[0][0], expectedPayload);
    assert.equal(JSON.stringify(warnings).includes(HOOK), false);
  }
});
