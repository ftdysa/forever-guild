# Discord Webhook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Post a Discord embed to a webhook whenever a new member is added to the roster.

**Architecture:** Optional `DISCORD_WEBHOOK_URL` config. `src/discord.ts` holds a pure `buildJoinEmbed` and a `DiscordNotifier` that never throws. The app decorates `app.notifier` (null when unconfigured), and `POST /api/members` fires `memberJoined` without awaiting it.

**Tech Stack:** TypeScript, Fastify 5, node:test + tsx, global `fetch`.

Spec: `docs/superpowers/specs/2026-10-25-discord-webhook-design.md`

## Global Constraints

- Only `POST /api/members` success posts. Update and delete never post.
- Webhook URL must match `https://discord.com/api/webhooks/...` or `https://discordapp.com/api/webhooks/...`; it is a secret and must never appear in logs or error messages.
- Request body: `{ embeds: [embed], allowed_mentions: { parse: [] } }`.
- Notes are never included in the embed.
- Priest colour `#FFFFFF` is replaced with `#C0C0C0`.
- 5 s timeout; no retries; Discord failures never change the API response.
- Checks: `npm run lint`, `npm run typecheck`, `npm test` must all pass.

---

### Task 1: Config

**Files:**
- Modify: `src/config.ts`
- Modify: `.env.example`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces: `export interface DiscordConfig { webhookUrl: string; siteUrl?: string }` and `Config.discord?: DiscordConfig` in `src/config.ts`.

- [ ] **Step 1: Write the failing tests** — append to `test/config.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- --test-name-pattern="discord|SITE_URL"` (or `NODE_ENV=test node --import tsx --test test/config.test.ts`)
Expected: FAIL — `discord` is undefined / no throw.

- [ ] **Step 3: Implement** — in `src/config.ts`, add `discord?: DiscordConfig;` to `Config` (after `blizzard`, with comment `// Discord join announcements; undefined when not configured.`), then add after `loadBlizzardConfig`:

```ts
export interface DiscordConfig {
  // Secret: never log it or echo it in errors.
  webhookUrl: string;
  siteUrl?: string;
}

const DISCORD_WEBHOOK_RE = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/;

function loadDiscordConfig(env: NodeJS.ProcessEnv): DiscordConfig | undefined {
  const siteUrl = env.SITE_URL || undefined;
  if (siteUrl && !/^https?:\/\/\S+$/.test(siteUrl)) throw new Error("SITE_URL must be an http(s) URL");
  const webhookUrl = env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return undefined;
  if (!DISCORD_WEBHOOK_RE.test(webhookUrl)) {
    throw new Error("DISCORD_WEBHOOK_URL must be a Discord webhook URL (https://discord.com/api/webhooks/...)");
  }
  return { webhookUrl, siteUrl };
}
```

and in `loadConfig`'s return object add `discord: loadDiscordConfig(env),` after `blizzard`.

- [ ] **Step 4: Document** — append to `.env.example`:

```
# Optional Discord announcement when someone joins the roster. Server Settings →
# Integrations → Webhooks → New Webhook → Copy URL. Secret: on Fly use fly secrets.
DISCORD_WEBHOOK_URL=
# public site address, linked from the Discord post
SITE_URL=
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts test/config.test.ts .env.example
git commit -m "feat: optional discord webhook config"
```

---

### Task 2: Embed builder and notifier

**Files:**
- Create: `src/discord.ts`
- Test: `test/discord.test.ts`

**Interfaces:**
- Consumes: `DiscordConfig` from `src/config.ts`; `Member` from `src/db.ts`; `FetchFn` from `src/blizzard.ts`; `findClass`, `findSpec`, `PROFESSIONS`, `SWEAT_FACTORS`, `LEVELING_PREFS` from `src/game-data.ts`.
- Produces:
  - `buildJoinEmbed(member: Member, siteUrl?: string): Embed`
  - `class DiscordNotifier { constructor(config: DiscordConfig, log: FastifyBaseLogger, fetchFn?: FetchFn); memberJoined(member: Member): Promise<void> }`

- [ ] **Step 1: Write the failing tests** — create `test/discord.test.ts`:

```ts
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
  for (const fetchFn of [
    (async () => new Response("slow down", { status: 429 })) as unknown as FetchFn,
    (async () => {
      throw new Error("boom");
    }) as unknown as FetchFn,
  ]) {
    const { log, warnings } = fakeLog();
    await new DiscordNotifier({ webhookUrl: HOOK }, log, fetchFn).memberJoined(thrall);
    assert.equal(warnings.length, 1);
    assert.equal(JSON.stringify(warnings).includes(HOOK), false);
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `NODE_ENV=test node --import tsx --test test/discord.test.ts`
Expected: FAIL — cannot find module `../src/discord.js`.

- [ ] **Step 3: Implement** — create `src/discord.ts`:

```ts
import type { FastifyBaseLogger } from "fastify";
import type { FetchFn } from "./blizzard.js";
import type { DiscordConfig } from "./config.js";
import type { Member } from "./db.js";
import { findClass, findSpec, LEVELING_PREFS, PROFESSIONS, SWEAT_FACTORS } from "./game-data.js";

export interface EmbedField {
  name: string;
  value: string;
  inline: boolean;
}

export interface Embed {
  title: string;
  url?: string;
  color: number;
  fields: EmbedField[];
  timestamp: string;
}

// Priest white is invisible on Discord's light theme.
const COLOR_OVERRIDES: Record<string, string> = { "#FFFFFF": "#C0C0C0" };
const TIMEOUT_MS = 5000;

const nameOf = (list: { id: string; name: string }[], id: string) => list.find((x) => x.id === id)?.name ?? id;

function classSpec(classId: string, specId: string): string {
  return `${findClass(classId)?.name ?? classId} — ${findSpec(classId, specId)?.name ?? specId}`;
}

export function buildJoinEmbed(m: Member, siteUrl?: string): Embed {
  const fields: EmbedField[] = [{ name: "Main", value: classSpec(m.mainClass, m.mainSpec), inline: true }];
  if (m.backupClass && m.backupSpec) {
    fields.push({ name: "Backup", value: classSpec(m.backupClass, m.backupSpec), inline: true });
  }
  const profs = [...m.primaryProfessions, ...m.secondaryProfessions].map((id) => nameOf(PROFESSIONS, id));
  if (profs.length > 0) fields.push({ name: "Professions", value: profs.join(", "), inline: false });
  const style = [
    m.sweatFactor && nameOf(SWEAT_FACTORS, m.sweatFactor),
    m.levelingPref && nameOf(LEVELING_PREFS, m.levelingPref),
  ].filter((s): s is string => !!s);
  if (style.length > 0) fields.push({ name: "Style", value: style.join(" · "), inline: false });

  const hex = findClass(m.mainClass)?.color ?? "#C0C0C0";
  return {
    title: `${m.characterName} joined the roster`,
    ...(siteUrl ? { url: siteUrl } : {}),
    color: parseInt((COLOR_OVERRIDES[hex] ?? hex).slice(1), 16),
    fields,
    timestamp: m.createdAt,
  };
}

export class DiscordNotifier {
  constructor(
    private config: DiscordConfig,
    private log: FastifyBaseLogger,
    private fetchFn: FetchFn = fetch,
  ) {}

  // Never throws: a lost announcement must not affect the API response. Logs never include the URL.
  async memberJoined(m: Member): Promise<void> {
    try {
      const res = await this.fetchFn(this.config.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ embeds: [buildJoinEmbed(m, this.config.siteUrl)], allowed_mentions: { parse: [] } }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) this.log.warn({ status: res.status }, "discord webhook rejected");
    } catch (err) {
      this.log.warn({ error: (err as Error).message }, "discord webhook failed");
    }
  }
}
```

- [ ] **Step 4: Verify**

Run: `NODE_ENV=test node --import tsx --test test/discord.test.ts && npm run typecheck && npm run lint`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/discord.ts test/discord.test.ts
git commit -m "feat: discord join embed and webhook notifier"
```

---

### Task 3: Wire into the app and members route

**Files:**
- Modify: `src/app.ts` (imports, `FastifyInstance` declaration, `AppDeps`, decorators)
- Modify: `src/routes/members.ts` (POST handler)
- Modify: `README.md`, `fly.toml` (secrets comment)
- Test: `test/discord-api.test.ts`

**Interfaces:**
- Consumes: `DiscordNotifier` from `src/discord.ts`; `Config.discord` from Task 1.
- Produces: `app.notifier: DiscordNotifier | null`; `AppDeps.discordFetch?: FetchFn`.

- [ ] **Step 1: Write the failing tests** — create `test/discord-api.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `NODE_ENV=test node --import tsx --test test/discord-api.test.ts`
Expected: FAIL — `calls.length` is 0 after create and `plain.notifier` is `undefined`.

- [ ] **Step 3: Wire the app** — in `src/app.ts`:

Add import after the blizzard import:

```ts
import { DiscordNotifier } from "./discord.js";
```

In `interface FastifyInstance`, after `armory: ArmoryService | null;`:

```ts
    notifier: DiscordNotifier | null;
```

In `AppDeps`, after `blizzardFetch`:

```ts
  // Replaces global fetch for Discord webhook calls (tests).
  discordFetch?: FetchFn;
```

After the `app.decorate("armory", ...)` call:

```ts
  app.decorate("notifier", config.discord ? new DiscordNotifier(config.discord, app.log, deps.discordFetch) : null);
```

- [ ] **Step 4: Fire from the route** — in `src/routes/members.ts` POST handler, after the `audit(req, "member.create", ...)` line:

```ts
      // Not awaited: Discord must not delay or fail the response.
      void app.notifier?.memberJoined(created);
```

- [ ] **Step 5: Verify**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all pass.

- [ ] **Step 6: Docs** — in `README.md`, add a section after the `## Armory (Blizzard API)` section (before the reset-data section):

```markdown
## Discord announcements

Optional. With `DISCORD_WEBHOOK_URL` set (see `.env.example`), each new roster
member is posted to that channel as an embed in their class colour, linking to
`SITE_URL` when set. Edits and removals are not posted. Delivery is
best-effort: if Discord is down the post is dropped and the roster save still
succeeds.

- The webhook URL is a secret. On Fly: `fly secrets set DISCORD_WEBHOOK_URL=...`.
```

In `fly.toml`, extend the secrets comment line:

```
#   BLIZZARD_CLIENT_ID=... BLIZZARD_CLIENT_SECRET=... DISCORD_WEBHOOK_URL=...
```

and under `[env]` add:

```toml
  SITE_URL = 'https://geriatrics-guild.fly.dev'
```

- [ ] **Step 7: Commit**

```bash
git add src/app.ts src/routes/members.ts test/discord-api.test.ts README.md fly.toml
git commit -m "feat: announce new roster members on discord"
```
