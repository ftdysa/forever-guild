import { test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { ArmoryService } from "../src/armory.js";
import { buildApp } from "../src/app.js";
import { BlizzardClient } from "../src/blizzard.js";
import { ArmoryCache, MemberStore, openDatabase, type Member } from "../src/db.js";
import type { DiscordNotifier } from "../src/discord.js";
import { GuildSync } from "../src/guild-sync.js";
import { ProgressRecorder } from "../src/progress.js";
import { ProgressStore } from "../src/progress-store.js";
import { sessionCookieName } from "../src/routes/auth.js";
import { fakeBlizzard, iconSearch } from "./fake-blizzard.js";

const ROSTER = "/data/wow/guild/old-school/roster";
const char = (slug: string) => `/profile/wow/character/${slug}`;
const rosterRow = (name: string, slug: string, classId: number, level: number) => ({
  character: { name, slug, level, playable_class: { id: classId } },
  rank: 4,
});

// Thrall (resto shaman, alchemist) is in the guild from the start; Jaina joins later.
function routes() {
  return {
    [ROSTER]: { members: [rosterRow("Thrall", "thrall-durotan", 7, 20)] },
    [char("thrall-durotan")]: { name: "Thrall", surname: "Durotan", level: 20, character_class: { id: 7 } },
    [`${char("thrall-durotan")}/specializations`]: {
      specialization_groups: [{ is_active: true, specializations: [{ specialization_name: "Restoration", spent_points: 11 }] }],
    },
    [`${char("thrall-durotan")}/professions`]: {
      primaries: [
        { profession: { name: "Alchemy" }, tiers: [{ skill_points: 60, max_skill_points: 75, known_recipes: [{ id: 2329 }] }] },
        { profession: { name: "Herbalism" } },
      ],
      secondaries: [{ profession: { name: "Cooking" } }],
    },
    [char("jaina-proudmoore")]: { name: "Jaina", level: 12, character_class: { id: 8 } },
    [`${char("jaina-proudmoore")}/specializations`]: {
      specialization_groups: [{ is_active: true, specializations: [{ specialization_name: "Frost", spent_points: 3 }] }],
    },
    "/data/wow/search/media": iconSearch,
  } as Record<string, unknown>;
}

const quietLog = { warn() {}, error() {} } as unknown as FastifyBaseLogger;
const cfg = { region: "us", namespace: "forever", guild: "old-school" };

function setup() {
  let t = 1_000_000;
  const r = routes();
  const fake = fakeBlizzard(r);
  const db = openDatabase(":memory:");
  const store = new MemberStore(db);
  const armory = new ArmoryService(new BlizzardClient({ clientId: "id", clientSecret: "s", region: "us", namespace: "forever" }, fake.fetchFn, undefined, async () => {}), new ArmoryCache(db), cfg, () => t);
  const joined: Member[] = [];
  const firsts: [string, string[]][] = [];
  const notifier = {
    memberJoined: async (m: Member) => void joined.push(m),
    guildFirsts: async (who: { name: string }, claims: string[]) => void firsts.push([who.name, claims]),
  } as unknown as DiscordNotifier;
  const progress = new ProgressStore(db);
  const sync = new GuildSync(armory, store, notifier, quietLog, () => t, new ProgressRecorder(progress, notifier, () => t));
  return {
    r, fake, store, sync, joined, progress, firsts,
    advance: (ms: number) => (t += ms),
    roster: (rows: unknown[]) => (r[ROSTER] = { members: rows }),
  };
}

test("the first sync seeds the roster silently and fills spec and professions from the armory", async () => {
  const { store, sync, joined } = setup();
  await sync.sync();
  assert.deepEqual(store.list().map((m) => [m.characterName, m.level, m.mainClass]), [["Thrall", 20, "shaman"]]);
  await sync.idle();
  const [thrall] = store.list();
  assert.equal(thrall.mainSpec, "restoration");
  assert.deepEqual(thrall.primaryProfessions, ["alchemy", "herbalism"]);
  assert.deepEqual(thrall.secondaryProfessions, ["cooking"]);
  // the armory snapshot is stored for the roster's extra columns
  assert.equal(thrall.armory?.lastLogin, null);
  assert.deepEqual(thrall.armory?.skills, { alchemy: { skill: 60, max: 75 } });
  assert.deepEqual(thrall.armory?.recipes, [2329]);
  assert.deepEqual(joined, []);
});

test("later syncs announce newcomers (with their spec) and drop leavers", async () => {
  const { store, sync, joined, advance, roster } = setup();
  await sync.sync();
  await sync.idle();
  roster([rosterRow("Jaina", "jaina-proudmoore", 8, 12)]);
  advance(16 * 60 * 1000); // past the roster cache
  await sync.sync();
  await sync.idle();
  assert.deepEqual(store.list().map((m) => m.characterName), ["Jaina"]);
  assert.deepEqual(joined.map((m) => [m.characterName, m.mainSpec]), [["Jaina", "frost"]]);
});

test("level-ups show on the next roster refresh; a chosen main spec survives", async () => {
  const { store, sync, advance, roster } = setup();
  await sync.sync();
  await sync.idle();
  const id = store.list()[0].id;
  store.updateDetails(id, { mainSpec: "enhancement", backupClass: null, backupSpec: null, sweatFactor: null, levelingPref: null, notes: "" });
  roster([rosterRow("Thrall", "thrall-durotan", 7, 21)]);
  advance(16 * 60 * 1000);
  await sync.sync();
  await sync.idle();
  assert.equal(store.get(id)?.level, 21);
  assert.equal(store.get(id)?.mainSpec, "enhancement");
});

test("concurrent syncs share one run", async () => {
  const { fake, sync } = setup();
  await Promise.all([sync.sync(), sync.sync(), sync.sync()]);
  assert.equal(fake.calls.filter((c) => c === ROSTER).length, 1);
});

test("a roster that can't be read rejects and leaves the members alone", async () => {
  const { fake, store, sync } = setup();
  fake.state.apiDown = true;
  await assert.rejects(sync.sync(), /unreachable/);
  assert.deepEqual(store.list(), []);
});

// --- Through the API ---
const PASS = "for-the-horde-forever";
const base = { port: 0, dbPath: ":memory:", guildPassphrase: PASS, sessionSecret: "x".repeat(40), cookieSecure: false };
const blizzard = { clientId: "id", clientSecret: "s", region: "us", namespace: "forever", guild: "old-school" };

async function login(a: FastifyInstance) {
  const res = await a.inject({ method: "POST", url: "/api/login", payload: { passphrase: PASS } });
  const name = sessionCookieName(false);
  return { [name]: res.cookies.find((c) => c.name === name)!.value };
}

test("GET /api/members syncs first", async () => {
  const fake = fakeBlizzard(routes());
  const app = buildApp({ ...base, blizzard }, { blizzardFetch: fake.fetchFn, blizzardSleep: async () => {}, syncEveryMs: 0 });
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/api/members", cookies: await login(app) });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().map((m: Member) => m.characterName), ["Thrall"]);
  } finally {
    await app.close();
  }
});

test("GET /api/members still answers when Blizzard is down", async () => {
  const fake = fakeBlizzard(routes());
  fake.state.apiDown = true;
  const app = buildApp({ ...base, blizzard }, { blizzardFetch: fake.fetchFn, blizzardSleep: async () => {}, syncEveryMs: 0 });
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/api/members", cookies: await login(app) });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), []);
  } finally {
    await app.close();
  }
});

test("without Blizzard config there is no sync and the roster is empty", async () => {
  const app = buildApp(base);
  await app.ready();
  try {
    assert.equal(app.guildSync, null);
    const res = await app.inject({ method: "GET", url: "/api/members", cookies: await login(app) });
    assert.deepEqual(res.json(), []);
  } finally {
    await app.close();
  }
});
test("progress: every sync snapshots the roster, and a level-60 ding on a later day is an announced guild first", async () => {
  const { r, fake, sync, advance, roster, progress, firsts } = setup();
  await sync.sync();
  await sync.idle();
  assert.deepEqual(progress.snapshots().map((s) => [s.name, s.day, s.level]), [["Thrall", "1970-01-01", 20]]);
  assert.deepEqual(progress.milestones(), []);

  advance(24 * 60 * 60 * 1000);
  const login = 86_400_000 + 500_000;
  roster([rosterRow("Thrall", "thrall-durotan", 7, 60)]);
  r[char("thrall-durotan")] = { name: "Thrall", surname: "Durotan", level: 60, character_class: { id: 7 }, race: { name: "Orc" }, last_login_timestamp: login };
  fake.state.lastModified = "Tue, 15 Sep 2026 00:00:00 GMT"; // they played: the armory refetches
  await sync.sync();
  await sync.idle();

  assert.deepEqual(progress.snapshots().map((s) => [s.day, s.level, s.race]), [["1970-01-01", 20, null], ["1970-01-02", 60, "Orc"]]);
  assert.deepEqual(progress.milestones().map((m) => [m.name, m.kind, m.key, m.source, m.reachedAt]), [
    ["Thrall", "level", "60", "observed", new Date(login).toISOString()],
  ]);
  assert.deepEqual(firsts, [["Thrall", ["First to reach level 60", "First Shaman to reach level 60", "First Orc to reach level 60"]]]);
});
