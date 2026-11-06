import { test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyBaseLogger } from "fastify";
import type { FetchFn } from "../src/blizzard.js";
import type { Member } from "../src/db.js";
import { buildFirstsEmbed, buildJoinEmbed, DiscordNotifier, type FirstsWho } from "../src/discord.js";

const thrall: Member = {
  id: 1,
  characterName: "Thrall",
  surname: "Durotan",
  mainClass: "shaman",
  mainSpec: "enhancement",
  level: 42,
  guildRank: 0,
  backupClass: "warrior",
  backupSpec: "protection",
  primaryProfessions: ["alchemy", "herbalism"],
  secondaryProfessions: ["first-aid"],
  altOf: null,
  levelingPref: "duo",
  notes: "secret plans",
  createdAt: "2026-10-25T12:00:00.000Z",
  updatedAt: "2026-10-25T12:00:00.000Z",
};

const bare: Member = {
  ...thrall,
  characterName: "Anduin",
  surname: null,
  mainClass: "priest",
  mainSpec: null,
  backupClass: null,
  backupSpec: null,
  primaryProfessions: [],
  secondaryProfessions: [],
  altOf: null,
  levelingPref: null,
};

test("join embed has title, class colour, and named fields", () => {
  const e = buildJoinEmbed(thrall, "https://example.test");
  assert.equal(e.title, "Thrall Durotan joined the guild");
  assert.equal(e.url, "https://example.test");
  assert.equal(e.color, 0x0070dd);
  assert.equal(e.timestamp, thrall.createdAt);
  assert.deepEqual(
    e.fields.map((f) => [f.name, f.value]),
    [
      ["Main", "Shaman — Enhancement"],
      ["Level", "42"],
      ["Backup", "Warrior — Protection"],
      ["Professions", "Alchemy, Herbalism, First Aid"],
      ["Style", "Duo"],
    ],
  );
});

test("join embed omits empty fields, url, and notes", () => {
  const e = buildJoinEmbed(bare);
  assert.equal("url" in e, false);
  // a newcomer whose spec isn't known yet shows just the class
  assert.deepEqual(e.fields.map((f) => [f.name, f.value]), [["Main", "Priest"], ["Level", "42"]]);
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


test("guild-firsts embed lists each claim and links to the Progress tab", () => {
  const e = buildFirstsEmbed(
    { name: "Thrall", surname: "Durotan", classId: "shaman" },
    ["First to reach level 60", "First Orc to reach level 60"],
    "2026-11-10T08:00:00.000Z",
    "https://example.test/",
  );
  assert.equal(e.title, "Thrall Durotan claimed 2 guild firsts");
  assert.equal(e.description, "🏆 First to reach level 60\n🏆 First Orc to reach level 60");
  assert.equal(e.url, "https://example.test/#progress");
  assert.equal(e.color, 0x0070dd);
  assert.deepEqual(e.fields, []);
  assert.equal(e.timestamp, "2026-11-10T08:00:00.000Z");
  const one = buildFirstsEmbed({ name: "Grom", surname: null, classId: "warrior" }, ["First to reach PvP rank 1"], "2026-11-10T08:00:00.000Z");
  assert.equal(one.title, "Grom claimed a guild first");
  assert.equal("url" in one, false);
});

test("notifier posts guild firsts and swallows failures", async () => {
  const calls: RequestInit[] = [];
  const ok = (async (_url: string, init: RequestInit) => {
    calls.push(init);
    return new Response(null, { status: 204 });
  }) as unknown as FetchFn;
  const who = { name: "Grom", surname: null, classId: "warrior" };
  await new DiscordNotifier({ webhookUrl: HOOK }, fakeLog().log, ok).guildFirsts(who, ["First to reach level 60"], "2026-11-10T08:00:00.000Z");
  assert.deepEqual(JSON.parse(String(calls[0].body)).embeds, [buildFirstsEmbed(who, ["First to reach level 60"], "2026-11-10T08:00:00.000Z")]);
  const boom = (async () => {
    throw new Error("boom");
  }) as unknown as FetchFn;
  const { log, warnings } = fakeLog();
  await new DiscordNotifier({ webhookUrl: HOOK }, log, boom).guildFirsts(who, ["x"], "2026-11-10T08:00:00.000Z");
  assert.deepEqual(warnings[0][0], { error: "boom" });
});

test("embed builder errors are logged, never thrown", async () => {
  const boom = { get mainClass(): string { throw new Error("boom"); } } as unknown as Member;
  const badWho = { get name(): string { throw new Error("boom"); } } as unknown as FirstsWho;
  let calls = 0;
  const fetchFn = (async () => { calls++; return new Response(null, { status: 204 }); }) as FetchFn;
  const { log, warnings } = fakeLog();
  const notifier = new DiscordNotifier({ webhookUrl: HOOK }, log, fetchFn);
  await notifier.memberJoined(boom);
  await notifier.guildFirsts(badWho, ["x"], "2026-11-05T00:00:00.000Z");
  assert.equal(calls, 0);
  assert.equal(warnings.length, 2);
  assert.deepEqual(warnings[0][0], { error: "boom" });
  assert.ok(!JSON.stringify(warnings).includes(HOOK));
});
